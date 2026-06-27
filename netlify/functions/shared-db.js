// netlify/functions/shared-db.js
const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;

if (!uri) {
  console.error('MONGODB_URI environment variable not set');
}

const client = new MongoClient(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

let dbConnection;

async function getDb() {
  if (dbConnection) {
    try {
      // Test connection
      await dbConnection.admin().ping();
      return dbConnection;
    } catch (error) {
      console.log('Connection lost, reconnecting...');
      dbConnection = null;
    }
  }
  
  try {
    await client.connect();
    dbConnection = client.db('hotelops');
    console.log('Connected to MongoDB');
    return dbConnection;
  } catch (error) {
    console.error('MongoDB connection error:', error);
    throw new Error('Failed to connect to database');
  }
}

const COLLECTIONS = {
  USERS: 'users',
  SESSIONS: 'sessions',
  EVENTS: 'events',
  STATS: 'stats'
};

module.exports = { getDb, COLLECTIONS };
