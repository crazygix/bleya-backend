import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

async function setup() {
    console.log('Setting up environment variables...\n');

    const envPath = path.join(__dirname, '..', '.env');
    const exampleEnvPath = path.join(__dirname, '..', '.env.example');

    // Check if .env already exists
    if (fs.existsSync(envPath)) {
        const answer = await question('.env file already exists. Do you want to overwrite it? (y/N): ');
        if (answer.toLowerCase() !== 'y') {
            console.log('Setup cancelled.');
            rl.close();
            return;
        }
    }

    // Get Firebase credentials
    console.log('\nFirebase Configuration:');
    const projectId = await question('Enter Firebase Project ID: ');
    const privateKey = await question('Enter Firebase Private Key: ');
    const clientEmail = await question('Enter Firebase Client Email: ');

    // Get MongoDB URI
    console.log('\nDatabase Configuration:');
    const mongoUri = await question('Enter MongoDB URI (default: mongodb://localhost:27017/bleya): ') || 'mongodb://localhost:27017/bleya';

    // Get server configuration
    console.log('\nServer Configuration:');
    const port = await question('Enter server port (default: 8080): ') || '8080';
    const clientUrl = await question('Enter client URL (default: http://localhost:8080): ') || 'http://localhost:8080';

    // Create .env content
    const envContent = `# Firebase Configuration
FIREBASE_PROJECT_ID=${projectId}
FIREBASE_PRIVATE_KEY=${privateKey}
FIREBASE_CLIENT_EMAIL=${clientEmail}

# Database Configuration
MONGODB_URI=${mongoUri}

# Server Configuration
PORT=${port}
NODE_ENV=development
CLIENT_URL=${clientUrl}
`;

    // Write to .env file
    fs.writeFileSync(envPath, envContent);
    console.log('\n.env file created successfully!');

    rl.close();
}

setup().catch(console.error); 