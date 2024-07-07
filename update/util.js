import path from 'path';
import { fileURLToPath } from 'url';
import { Route53Client } from '@aws-sdk/client-route-53';

export const DOMAINS = [
    'featherine.com',
    'alpha.featherine.com',
    'server.featherine.com',
    'server.alpha.featherine.com',
    'cdn.featherine.com',
    'cdn.alpha.featherine.com',
];
export const HOST_ZONE_ID = process.env.HOST_ZONE_ID;
if (HOST_ZONE_ID === undefined) {
    throw new Error('HOST_ZONE_ID is not defined');
}
const __filename = fileURLToPath(import.meta.url);
export const __dirname = path.dirname(__filename);
export const route53Client = new Route53Client({ region: 'us-west-2' });