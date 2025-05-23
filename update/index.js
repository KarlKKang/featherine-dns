import { execFile } from 'child_process';
import { promisify } from 'util';
import ipaddr from 'ipaddr.js';
import { readFileSync } from 'fs';
import path from 'path';
import { ChangeResourceRecordSetsCommand } from '@aws-sdk/client-route-53';
import http from 'node:http';
import { performance } from 'perf_hooks';
import { HOST_ZONE_ID, DOMAINS, __dirname, route53Client } from './util.js';

const NO_IPV6 = process.env.NO_IPV6 === '1';
const promiseExecFile = promisify(execFile);

/** @type {any} */
let jobID;

/**
 * @typedef {{time: number, next: Route53ApiRequestListNode|null}} Route53ApiRequestListNode
 */
/** @type {Route53ApiRequestListNode|null} */
let route53ApiRequestListHead = null;

/**
 * @param {string} hostname
 * @param {'A'|'AAAA'} type
 * @param {string} subnet
 */
async function dnsLookup(hostname, type, subnet) {
    const { stdout } = await promiseExecFile('dig', ['@ns-1643.awsdns-13.co.uk', hostname, type, '+subnet=' + subnet, '+short']);
    const results = [];
    const lines = stdout.split('\n');
    for (const line of lines) {
        try {
            ipaddr.parse(line);
        } catch (e) {
            continue;
        }
        results.push(line);
    }
    if (results.length === 0) {
        throw new Error(`No ${type} records found for ${hostname}`);
    }
    return results;
}

/**
 * @param {string} ip
 * @returns {Promise<string>}
 */
async function ipLocation(ip) {
    return new Promise((resolve) => {
        const req = http.request({
            hostname: ip,
            method: 'HEAD',
        }, (res) => {
            const location = res.headers['x-amz-cf-pop'];
            if (location === undefined || Array.isArray(location)) {
                resolve('');
            } else {
                resolve(location);
            }
            res.resume();
        });
        req.on('error', () => resolve(''));
        req.end();
    });
}

/**
 * @param {string} hostname
 * @param {"A"|"AAAA"} type
 * @param {string[]} ipList
 */
function toChangeObj(hostname, type, ipList) {
    return /** @type {const} */ ({
        Action: 'UPSERT',
        ResourceRecordSet: {
            Name: hostname,
            Type: type,
            TTL: 60,
            ResourceRecords: ipList.map(ip => ({ Value: ip }))
        }
    });
}

/**
 * @param {string} locationLower
 * @param {string[]|undefined} neighbors
 */
function checkNeighbor(locationLower, neighbors) {
    if (neighbors === undefined) {
        return false;
    }
    for (const neighbor of neighbors) {
        if (locationLower.startsWith(neighbor.toLowerCase())) {
            return true;
        }
    }
    return false;
}

/**
 * @param {string} domain
 * @param {string} code
 * @param {'A'|'AAAA'} type
 * @param {string} subnet
 * @param {string[]|undefined} neighbors
 */
async function getChangeObj(domain, code, type, subnet, neighbors) {
    /** @type {Awaited<ReturnType<dnsLookup>>} */
    let ipResults;
    let retryCount = 0;
    while (true) {
        let dnsLookupRetryCount = 0;
        while (true) {
            try {
                ipResults = await dnsLookup(domain, type, subnet);
                break;
            } catch (e) {
                if (dnsLookupRetryCount++ >= 3) {
                    throw e;
                }
            }
        }
        const location = (await ipLocation(ipResults[0])).toLowerCase();
        if (location.startsWith(code)) {
            break;
        }
        if (checkNeighbor(location, neighbors)) {
            console.log(`Neighbor location for ${domain} in ${code}: ${location}`);
            break;
        }
        if (retryCount++ >= 5) {
            console.warn(`Location mismatch for ${domain} in ${code}: ${location}`);
            break;
        }
    }
    return toChangeObj(code + '.' + domain, type, ipResults);
}

/**
 * @param {{Changes: ReturnType<typeof toChangeObj>[]}} changeBatch
 */
async function updateDNS(changeBatch) {
    const command = new ChangeResourceRecordSetsCommand({
        ChangeBatch: changeBatch,
        HostedZoneId: HOST_ZONE_ID
    });

    let periodStartTime = 0;
    let requestCount = 0;
    let current = route53ApiRequestListHead;
    /** @type {Route53ApiRequestListNode|null} */
    let previous = null;

    while (current !== null) {
        if (performance.now() - current.time > 1000) {
            if (previous === null) {
                route53ApiRequestListHead = current.next;
            } else {
                previous.next = current.next;
            }
        } else {
            periodStartTime = current.time;
            requestCount++;
            previous = current;
        }
        current = current.next;
    }

    if (requestCount >= 5) {
        const sleepTime = 1000 - (performance.now() - periodStartTime);
        if (sleepTime > 0) {
            await new Promise(resolve => setTimeout(resolve, sleepTime));
        }
    }

    try {
        await route53Client.send(command);
    } finally {
        const newRequestNode = { time: performance.now(), next: route53ApiRequestListHead };
        route53ApiRequestListHead = newRequestNode;
    }
}

async function main() {
    const startTime = performance.now();
    console.log('Starting DNS update');

    const currentJobID = {};
    jobID = currentJobID;
    route53ApiRequestListHead = null;
    /** @type {{id: string, location: string, country: string, subnet: string, code: string, neighbors: string[]|undefined}[]} */
    const pops = JSON.parse(readFileSync(path.join(__dirname, '..', 'pop.json'), 'utf8'));

    for (const pop of pops) {
        if (jobID !== currentJobID) {
            console.warn('DNS update aborted');
            return;
        }

        /** @type {ReturnType<typeof getChangeObj>[]} */
        const promises = [];
        for (const domain of DOMAINS) {
            const code = pop.code.toLowerCase();
            promises.push(getChangeObj(domain, code, 'A', pop.subnet, pop.neighbors));
            if (!NO_IPV6) {
                promises.push(getChangeObj(domain, code, 'AAAA', pop.subnet, pop.neighbors));
            }
        }

        /** @type {{Changes: ReturnType<typeof toChangeObj>[]}} */
        let currentChangeBatch = { Changes: [] };
        let changeBatches = [currentChangeBatch];
        let characterCount = 0;
        let recordCount = 0;
        let promiseResults = await Promise.allSettled(promises);
        for (const result of promiseResults) {
            if (result.status === 'rejected') {
                console.error(result.reason);
                continue;
            }
            const changeObj = result.value;
            let currentCharacterCount = 0;
            for (const ip of changeObj.ResourceRecordSet.ResourceRecords) {
                currentCharacterCount += ip.Value.length;
            }
            characterCount += currentCharacterCount;
            recordCount += changeObj.ResourceRecordSet.ResourceRecords.length;
            if (recordCount > 500 || characterCount > 16000) {
                currentChangeBatch = { Changes: [] };
                changeBatches.push(currentChangeBatch);
                characterCount = currentCharacterCount;
                recordCount = changeObj.ResourceRecordSet.ResourceRecords.length;
            }
            currentChangeBatch.Changes.push(changeObj);
        }

        for (const changeBatch of changeBatches) {
            let retryCount = 0;
            while (true) {
                if (jobID !== currentJobID) {
                    console.warn('DNS update aborted');
                    return;
                }
                try {
                    await updateDNS(changeBatch);
                    break;
                } catch (e) {
                    if (retryCount++ >= 3) {
                        console.error(e);
                        break;
                    }
                }
            }
        }
    }

    console.log(`DNS update completed in ${Math.round(performance.now() - startTime) / 1000}s`);
}

setInterval(main, 60000);