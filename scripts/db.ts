import readline from 'readline';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { cityRepository } from '../repositories/cityRepository.js';

interface CityJsonEntry {
    name: string;
    lat: number;
    lng: number;
    country: string;
    country_code: string;
    population: number;
}

type Action = 'clean' | 'import-cities' | 'reset' | 'quit';

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
        description: 'Drops all collections. Asks whether to also drop the cities collection.',
    },
    {
        key: '2',
        action: 'import-cities',
        title: 'Import cities',
        description: 'Imports cities from data/cities.json into the cities collection.',
    },
    {
        key: '3',
        action: 'reset',
        title: 'Reset (clean + import cities)',
        description: 'Drops everything (including cities) and re-imports cities from data/cities.json.',
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

function resolveCitiesJsonPath(): string {
    return path.resolve(process.cwd(), 'data/cities.json');
}

async function runAction(action: Action) {
    switch (action) {
        case 'clean': {
            const alsoDropCities = await askYesNo('Also drop the cities collection? (y/N) ');
            await cleanDatabase(alsoDropCities);
            break;
        }
        case 'import-cities':
            await importCities(resolveCitiesJsonPath());
            break;
        case 'reset':
            await cleanDatabase(true);
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
