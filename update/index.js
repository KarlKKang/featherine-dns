import { exec } from 'child_process';
import { promisify } from 'util';
import ipaddr from 'ipaddr.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ChangeResourceRecordSetsCommand, Route53Client } from '@aws-sdk/client-route-53';
import http from 'node:http';

const DOMAINS = [
    'featherine.com',
    'alpha.featherine.com',
    'server.featherine.com',
    'server.alpha.featherine.com',
    'cdn.featherine.com',
    'cdn.alpha.featherine.com',
];
const HOST_ZONE_ID = process.env.HOST_ZONE_ID;
const THREAD = process.env.THREAD;
const THREAD_COUNT = process.env.THREAD_COUNT;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const promiseExec = promisify(exec);

/**
 * @param {string} hostname
 * @param {'A'|'AAAA'} type
 * @param {string} subnet
 */
async function dnsLookup(hostname, type, subnet) {
    const { stdout } = await promiseExec(`dig @8.8.8.8 ${hostname} ${type} +subnet=${subnet} +short`);
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
 * @param {Route53Client} client
 */
async function updateDNS(changeBatch, client) {
    const command = new ChangeResourceRecordSetsCommand({
        ChangeBatch: changeBatch,
        HostedZoneId: HOST_ZONE_ID
    });
    await client.send(command);
}

async function main() {
    if (HOST_ZONE_ID === undefined) {
        throw new Error('HOST_ZONE_ID is not defined');
    }
    if (THREAD === undefined) {
        throw new Error('THREAD is not defined');
    }
    if (THREAD_COUNT === undefined) {
        throw new Error('THREAD_COUNT is not defined');
    }
    const thread = parseInt(THREAD);
    const threadCount = parseInt(THREAD_COUNT);
    if (threadCount < 1) {
        throw new Error('THREAD_COUNT must be at least 1');
    }
    if (thread < 1 || thread > threadCount) {
        throw new Error('THREAD must be between 1 and THREAD_COUNT');
    }

    /** @type {{id: string, location: string, country: string, subnet: string, code: string}[]} */
    const pops = JSON.parse(readFileSync(path.join(__dirname, '..', 'pop.json'), 'utf8'));

    const domainLength = DOMAINS.length;
    const domainSlice = DOMAINS.slice(Math.floor((thread - 1) / threadCount * domainLength), Math.floor(thread / threadCount * domainLength));

    /** @type {ReturnType<typeof getChangeObj>[]} */
    const promises = [];
    for (const domain of domainSlice) {
        for (const pop of pops) {
            const code = pop.code.toLowerCase();
            promises.push(getChangeObj(domain, code, 'A', pop.subnet));
            promises.push(getChangeObj(domain, code, 'AAAA', pop.subnet));
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

    const client = new Route53Client({ region: 'us-east-1' });
    for (const changeBatch of changeBatches) {
        let retryCount = 0;
        while (true) {
            try {
                await updateDNS(changeBatch, client);
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

main()