import { readFileSync } from 'fs';
import path from 'path';
import { ListResourceRecordSetsCommand, ChangeResourceRecordSetsCommand, RRType } from '@aws-sdk/client-route-53';
import { HOST_ZONE_ID, DOMAINS, __dirname, route53Client } from './util.js';

let requestCount = 0;

async function sleep1Second() {
    return new Promise((resolve) => {
        setTimeout(resolve, 1000);
    });
}

async function listAllRecords() {
    const allRecords = [];
    /** @type {{StartRecordName?: string, StartRecordType?: RRType, StartRecordIdentifier?: string}} */
    let startRecord = {};
    while (true) {
        const { ResourceRecordSets, IsTruncated, NextRecordName, NextRecordType, NextRecordIdentifier } = await route53Client.send(
            new ListResourceRecordSetsCommand({
                HostedZoneId: HOST_ZONE_ID,
                ...startRecord
            })
        );
        requestCount++;
        if (requestCount >= 5) {
            await sleep1Second();
            requestCount = 0;
        }
        if (ResourceRecordSets === undefined) {
            throw new Error('`ResourceRecordSets` is undefined');
        }
        allRecords.push(...ResourceRecordSets);
        if (!IsTruncated) {
            break;
        }
        startRecord = {
            StartRecordName: NextRecordName,
            StartRecordType: NextRecordType,
            StartRecordIdentifier: NextRecordIdentifier,
        };
    }
    return allRecords;
}

/**
 * @param {Awaited<ReturnType<typeof listAllRecords>>} records
 */
function filterRecords(records) {
    /** @type {{id: string, location: string, country: string, subnet: string, code: string, neighbors: string[]|undefined}[]} */
    const pops = JSON.parse(readFileSync(path.join(__dirname, '..', 'pop.json'), 'utf8'));
    const hostnamesToDelete = [];
    for (const pop of pops) {
        for (const domain of DOMAINS) {
            hostnamesToDelete.push(`${pop.code}.${domain}`);
        }
    }
    /** @type {{Changes: {Action: 'DELETE', ResourceRecordSet: typeof records[0]}[]}} */
    let currentChangeBatch = { Changes: [] };
    let changeBatches = [currentChangeBatch];
    let characterCount = 0;
    let recordCount = 0;
    for (const record of records) {
        if (record.Name !== undefined && record.ResourceRecords !== undefined && hostnamesToDelete.includes(record.Name)) {
            let currentCharacterCount = 0;
            for (const ip of record.ResourceRecords) {
                if (ip.Value !== undefined) {
                    currentCharacterCount += ip.Value.length;
                }
            }
            characterCount += currentCharacterCount;
            recordCount += record.ResourceRecords.length;
            if (recordCount > 1000 || characterCount > 32000) {
                currentChangeBatch = { Changes: [] };
                changeBatches.push(currentChangeBatch);
                characterCount = currentCharacterCount;
                recordCount = record.ResourceRecords.length;
            }
            currentChangeBatch.Changes.push({
                Action: 'DELETE',
                ResourceRecordSet: record
            });
        }
    }
    if (currentChangeBatch.Changes.length === 0) { // Only happen if there are no records to delete
        changeBatches.pop();
    }
    return changeBatches;
}

/**
 * @param {ReturnType<typeof filterRecords>} changeBatches
 */
async function deleteRecords(changeBatches) {
    for (const changeBatch of changeBatches) {
        await route53Client.send(
            new ChangeResourceRecordSetsCommand({
                HostedZoneId: HOST_ZONE_ID,
                ChangeBatch: changeBatch
            })
        );
        requestCount++;
        if (requestCount >= 5) {
            await sleep1Second();
            requestCount = 0;
        }
    }
}

async function main() {
    const records = await listAllRecords();
    const changeBatches = filterRecords(records);
    await deleteRecords(changeBatches);
}

main();