import { exec } from 'child_process';
import { promisify } from 'util';
import ipaddr from 'ipaddr.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ChangeResourceRecordSetsCommand, Route53Client } from '@aws-sdk/client-route-53';

const DOMAINS = [
    'featherine.com',
    'alpha.featherine.com',
    'server.featherine.com',
    'server.alpha.featherine.com',
    'cdn.featherine.com',
    'cdn.alpha.featherine.com',
];
const HOST_ZONE_ID = process.env.HOST_ZONE_ID;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const promiseExec = promisify(exec);

/**
 * @param {string} hostname
 * @param {string} subnet
 */
async function dnsLookup(hostname, subnet) {
    const { stdout } = await promiseExec(`dig @8.8.8.8 ${hostname} A +subnet=${subnet} ${hostname} AAAA +subnet=${subnet} +short`);
    const ipv4Results = [];
    const ipv6Results = [];
    const lines = stdout.split('\n');
    for (const line of lines) {
        try {
            const parseResult = ipaddr.parse(line);
            if (parseResult.kind() === 'ipv4') {
                ipv4Results.push(line);
            } else {
                ipv6Results.push(line);
            }
        } catch (e) {
            continue;
        }
    }
    if (ipv4Results.length === 0 || ipv6Results.length === 0) {
        throw new Error(`No IPv4 or IPv6 addresses found for ${hostname}`);
    }
    return [ipv4Results, ipv6Results];
}

/**
 * @param {string} hostname
 * @param {string} ip
 * @param {string} code
 */
async function validateLocation(hostname, ip, code) {
    const { stdout } = await promiseExec(`dig -x ${ip} +short`);
    const reverseHostname = stdout.split('\n')[0];
    if (!reverseHostname) {
        throw new Error(`No hostname found for IP ${ip}`);
    }
    if (!reverseHostname.startsWith('server-' + ip.replaceAll('.', '-') + '.' + code.toLowerCase())) {
        console.warn(`Location mismatch for ${hostname} in ${code}: ${reverseHostname}`);
    }
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
 * @param {string} subnet
 */
async function getChangeObj(domain, code, subnet) {
    const [ipv4Results, ipv6Results] = await dnsLookup(domain, subnet);
    await validateLocation(domain, ipv4Results[0], code);
    return [toChangeObj(code + '.' + domain, 'A', ipv4Results), toChangeObj(code + '.' + domain, 'AAAA', ipv6Results)];
}

/**
 * @param {{Changes: ReturnType<typeof toChangeObj>[]}} changeBatch
 */
async function updateDNS(changeBatch) {
    const client = new Route53Client({ region: 'us-east-1' });
    const command = new ChangeResourceRecordSetsCommand({
        ChangeBatch: changeBatch,
        HostedZoneId: HOST_ZONE_ID
    });
    await client.send(command);
}

async function main() {
    /** @type {{id: string, location: string, country: string, subnet: string, code: string}[]} */
    const pops = JSON.parse(readFileSync(path.join(__dirname, '..', 'pop.json'), 'utf8'));

    /** @type {ReturnType<typeof getChangeObj>[]} */
    const promises = [];
    for (const domain of DOMAINS) {
        for (const pop of pops) {
            promises.push(getChangeObj(domain, pop.code.toLowerCase(), pop.subnet));
        }
    }

    /** @type {{Changes: ReturnType<typeof toChangeObj>[]}} */
    let currentChangeBatch = { Changes: [] };
    let changeBatches = [currentChangeBatch];
    let characterCount = 0;
    let promiseResults = await Promise.allSettled(promises);
    for (const result of promiseResults) {
        if (result.status === 'rejected') {
            console.error(result.reason);
            continue;
        }
        const changeObjs = result.value;
        for (const changeObj of changeObjs) {
            let currentCharacterCount = 0;
            for (const ip of changeObj.ResourceRecordSet.ResourceRecords) {
                currentCharacterCount += ip.Value.length;
            }
            characterCount += currentCharacterCount;
            if (currentChangeBatch.Changes.length >= 500 || characterCount > 16000) {
                currentChangeBatch = { Changes: [] };
                changeBatches.push(currentChangeBatch);
                characterCount = currentCharacterCount;
            }
            currentChangeBatch.Changes.push(changeObj);
        }
    }

    for (const changeBatch of changeBatches) {
        await updateDNS(changeBatch);
    }
}

main()