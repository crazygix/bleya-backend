# Bleya Chat App

## Setup Instructions

1. Clone the repository
```bash
git clone <repository-url>
cd bleya
```

2. Install dependencies
```bash
npm install
```

3. Set up environment variables
   - Copy `.env.example` to `.env`
   - Fill in the required credentials:
     - Firebase credentials from Firebase Console
     - MongoDB connection string
     - Other configuration values

4. Start the development server
```bash
npm start
```

## Required Environment Variables

Create a `.env` file in the root directory with the following variables:

```
# Firebase Configuration
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_PRIVATE_KEY=your-private-key
FIREBASE_CLIENT_EMAIL=your-client-email

# Database Configuration
MONGODB_URI=mongodb://localhost:27017/bleya

# Server Configuration
PORT=8080
NODE_ENV=development
CLIENT_URL=http://localhost:8080
```

## Getting Firebase Credentials

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project
3. Go to Project Settings > Service Accounts
4. Click "Generate New Private Key"
5. Use the values from the downloaded JSON file in your `.env` file

## Development

- The server runs on port 8080 by default
- API endpoints are available at `http://localhost:8080/api`
- Authentication endpoints:
  - `POST /api/auth/create-account` - Create new account
  - `POST /api/auth/verify-phone` - Verify phone number
  - `POST /api/auth/verify-token` - Verify authentication token 