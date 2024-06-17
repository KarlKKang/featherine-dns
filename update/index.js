import { execFile } from 'child_process';
import { promisify } from 'util';
import ipaddr from 'ipaddr.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ChangeResourceRecordSetsCommand, Route53Client } from '@aws-sdk/client-route-53';
import http from 'node:http';
import { performance } from 'perf_hooks';

const DOMAINS = [
    'featherine.com',
    'alpha.featherine.com',
    'server.featherine.com',
    'server.alpha.featherine.com',
    'cdn.featherine.com',
    'cdn.alpha.featherine.com',
];
const HOST_ZONE_ID = process.env.HOST_ZONE_ID;
if (HOST_ZONE_ID === undefined) {
    throw new Error('HOST_ZONE_ID is not defined');
}
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const promiseExecFile = promisify(execFile);
const route53Client = new Route53Client({ region: 'us-west-2' });

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
    const { stdout } = await promiseExecFile('dig', ['@8.8.8.8', hostname, type, '+subnet=' + subnet, '+short']);
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
 * @param {string} domain
 * @param {string} code
 * @param {'A'|'AAAA'} type
 * @param {string} subnet
 */
async function getChangeObj(domain, code, type, subnet) {
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
        const location = await ipLocation(ipResults[0]);
        if (location.toLowerCase().startsWith(code)) {
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

    route53ApiRequestListHead = null;
    /** @type {{id: string, location: string, country: string, subnet: string, code: string}[]} */
    const pops = JSON.parse(readFileSync(path.join(__dirname, '..', 'pop.json'), 'utf8'));

    for (const pop of pops) {
        /** @type {ReturnType<typeof getChangeObj>[]} */
        const promises = [];
        for (const domain of DOMAINS) {
            const code = pop.code.toLowerCase();
            promises.push(getChangeObj(domain, code, 'A', pop.subnet));
            promises.push(getChangeObj(domain, code, 'AAAA', pop.subnet));
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