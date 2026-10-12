import readline from 'readline';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { config, validateR2Config } from '../config/index.js';
import { cityRepository } from '../repositories/cityRepository.js';

interface CityJsonEntry {
    name: string;
    lat: number;
    lng: number;
    country: string;
    country_code: string;
    population: number;
}

type Action = 'clean' | 'import-cities' | 'empty-r2' | 'quit';

interface MenuItem {
    key: string;
    action: Action;
    title: string;
    description: string;
}

const MENU: MenuItem[] = [
    {
        key: '1',
        action: 'clean',
        title: 'Clean database',
        description: 'Drops all collections. Asks whether to also drop the cities collection and empty the R2 bucket.',
    },
    {
        key: '2',
        action: 'import-cities',
        title: 'Import cities',
        description: 'Imports cities from data/cities.json into the cities collection.',
    },
    {
        key: '3',
        action: 'empty-r2',
        title: 'Empty R2 bucket',
        description: 'Deletes every object in R2_BUCKET_NAME and clears city image URLs. The bucket itself is kept.',
    },
    {
        key: 'q',
        action: 'quit',
        title: 'Quit',
        description: 'Exit without doing anything.',
    },
];

function ask(question: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

async function askYesNo(question: string): Promise<boolean> {
    const answer = await ask(question);
    return answer.toLowerCase() === 'y';
}

function describeTarget(): { host: string; dbName: string; isLocal: boolean } {
    const match = config.mongoUri.match(/^[^:]+:\/\/(?:[^@/]+@)?([^/?]+)(?:\/([^?]*))?/);
    const host = match?.[1] ?? '(unknown)';
    const dbName = match?.[2] || '(default)';
    const isLocal = /^(localhost|127\.0\.0\.1)/i.test(host);
    return { host, dbName, isLocal };
}

async function confirmTarget(actionLabel: string): Promise<boolean> {
    const { host, dbName, isLocal } = describeTarget();

    console.log('');
    console.log(`About to ${actionLabel}:`);
    console.log(`  host:     ${host}`);
    console.log(`  database: ${dbName}`);
    console.log(`  env:      ${config.nodeEnv}`);

    if (!isLocal || config.isProduction) {
        console.log('');
        console.log('  WARNING: this does NOT look like a local database.');
        const typed = await ask(`Type the database name to confirm ("${dbName}"): `);
        if (typed !== dbName) {
            console.log('Confirmation failed. Aborting.');
            return false;
        }
        return true;
    }

    return askYesNo('Continue? (y/N) ');
}

async function promptMenu(): Promise<Action> {
    console.log('');
    console.log('Bleya DB tool');
    console.log(`Database: ${config.mongoUri}`);
    console.log('');
    console.log('What do you want to do?');
    console.log('');
    for (const item of MENU) {
        console.log(`  ${item.key}) ${item.title}`);
        console.log(`     ${item.description}`);
    }
    console.log('');

    while (true) {
        const answer = (await ask('Choose an option: ')).toLowerCase();
        const item = MENU.find((m) => m.key === answer);
        if (item) {
            return item.action;
        }
        console.log(`Invalid choice "${answer}". Try again.`);
    }
}

function createCitySlug(name: string, country: string, lat: number, lng: number): string {
    const coordHash = crypto.createHash('md5')
        .update(`${lat},${lng}`)
        .digest('hex')
        .substring(0, 8);

    return `${name}-${country}-${coordHash}`
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-|-$/g, '');
}

async function cleanDatabase(dropCities: boolean) {
    const db = mongoose.connection.db;
    if (!db) {
        throw new Error('Mongo connection has no database handle');
    }

    const collections = await db.listCollections().toArray();
    const toDrop = collections.filter((c) => dropCities || c.name !== 'cities');

    if (toDrop.length === 0) {
        console.log('Nothing to drop.');
        return;
    }

    console.log(`\nDropping ${toDrop.length} collections from '${db.databaseName}':`);
    for (const c of toDrop) {
        console.log(`  - ${c.name}`);
        await db.collection(c.name).drop();
    }
    console.log('Clean done.');
}

async function importCities(jsonPath: string) {
    const jsonContent = await fs.readFile(jsonPath, 'utf-8');
    const cities: CityJsonEntry[] = JSON.parse(jsonContent);

    console.log(`\nImporting ${cities.length} cities from ${jsonPath}...`);

    const batchSize = 1000;
    for (let i = 0; i < cities.length; i += batchSize) {
        const batch = cities.slice(i, i + batchSize);
        const cityDocs = batch.map((city) => ({
            _id: createCitySlug(city.name, city.country_code, city.lat, city.lng),
            name: city.name,
            country: city.country_code,
            countryName: city.country,
            location: {
                type: 'Point' as const,
                coordinates: [city.lng, city.lat] as [number, number],
            },
            population: city.population,
        }));

        await cityRepository.upsertMany(cityDocs);
        console.log(`  Imported ${i + batch.length} / ${cities.length}`);
    }

    console.log('Import complete.');
}

async function confirmR2Target(): Promise<boolean> {
    const { complete, missing } = validateR2Config();
    if (!complete) {
        console.log(`\nR2 configuration incomplete, missing: ${missing.join(', ')}. Skipping R2.`);
        return false;
    }

    const bucketName = config.r2.bucketName;
    console.log('');
    console.log('About to EMPTY the R2 bucket:');
    console.log(`  endpoint: ${config.r2.endpoint}`);
    console.log(`  bucket:   ${bucketName}`);
    console.log(`  env:      ${config.nodeEnv}`);
    console.log('');
    const typed = await ask(`Type the bucket name to confirm ("${bucketName}"): `);
    if (typed !== bucketName) {
        console.log('Confirmation failed. Skipping R2.');
        return false;
    }
    return true;
}

async function emptyR2Bucket() {
    const bucketName = config.r2.bucketName;
    const client = new S3Client({
        region: 'auto',
        endpoint: config.r2.endpoint,
        forcePathStyle: true,
        credentials: {
            accessKeyId: config.r2.accessKeyId,
            secretAccessKey: config.r2.secretAccessKey,
        },
    });

    console.log(`\nEmptying R2 bucket '${bucketName}'...`);

    let deleted = 0;
    let continuationToken: string | undefined;
    try {
        do {
            const page = await client.send(new ListObjectsV2Command({
                Bucket: bucketName,
                ContinuationToken: continuationToken,
                MaxKeys: 1000,
            }));

            const keys = (page.Contents ?? [])
                .map((o) => o.Key)
                .filter((key): key is string => Boolean(key));

            if (keys.length > 0) {
                const result = await client.send(new DeleteObjectsCommand({
                    Bucket: bucketName,
                    Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
                }));

                if (result.Errors && result.Errors.length > 0) {
                    for (const err of result.Errors) {
                        console.log(`  failed: ${err.Key} (${err.Code}: ${err.Message})`);
                    }
                    throw new Error(`Failed to delete ${result.Errors.length} objects`);
                }

                deleted += keys.length;
                console.log(`  Deleted ${deleted} objects`);
            }

            continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (continuationToken);
    } finally {
        client.destroy();
    }

    console.log(deleted === 0 ? 'Bucket was already empty.' : `R2 empty done (${deleted} objects).`);
}

// City images live in R2, so once the bucket is empty the stored URLs point at
// nothing. Clearing them lets each city fetch a fresh image on its next listing.
async function clearCityImageUrls() {
    const result = await mongoose.connection.collection('cities').updateMany(
        { imageUrl: { $exists: true, $nin: [null, ''] } },
        { $unset: { imageUrl: '', imageCheckedAt: '' } }
    );
    console.log(`Cleared image URLs on ${result.modifiedCount} cities.`);
}

function resolveCitiesJsonPath(): string {
    return path.resolve(process.cwd(), 'data/cities.json');
}

async function runAction(action: Action) {
    switch (action) {
        case 'clean': {
            if (!(await confirmTarget('CLEAN the database'))) return;
            const alsoDropCities = await askYesNo('Also drop the cities collection? (y/N) ');
            const alsoEmptyR2 = await askYesNo('Also empty the R2 bucket? (y/N) ');
            await cleanDatabase(alsoDropCities);
            if (alsoEmptyR2 && (await confirmR2Target())) {
                await emptyR2Bucket();
                await clearCityImageUrls();
            }
            break;
        }
        case 'empty-r2':
            if (!(await confirmR2Target())) return;
            await emptyR2Bucket();
            await clearCityImageUrls();
            break;
        case 'import-cities':
            if (!(await confirmTarget('IMPORT cities into the database'))) return;
            await importCities(resolveCitiesJsonPath());
            break;
        case 'quit':
            console.log('Bye.');
            break;
    }
}

async function run() {
    const action = await promptMenu();
    if (action === 'quit') {
        return;
    }

    await mongoose.connect(config.mongoUri);
    try {
        await runAction(action);
    } finally {
        await mongoose.disconnect();
    }
}

run().catch((err) => {
    console.error('\ndb script failed:', err);
    process.exit(1);
});
