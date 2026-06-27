// netlify/functions/auth.js
const { getDb, COLLECTIONS } = require('./shared-db');
const crypto = require('crypto');

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event, context) => {
  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const db = await getDb();
    const body = JSON.parse(event.body);
    const { action, code, deviceId, deviceName, sessionToken } = body;

    // VALID_INVITE_CODES mapping
    const VALID_CODES = {
      'STAFFINV': 'staff',
      'FOUNDINV': 'founder', 
      'ADMININV': 'admin'
    };

    if (action === 'validate') {
      const role = VALID_CODES[code];
      
      if (!role) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Invalid code' })
        };
      }

      // Generate session token
      const sessionTokenNew = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

      // Create or update user
      const user = {
        deviceId,
        deviceName,
        role,
        sessionToken: sessionTokenNew,
        expiresAt,
        createdAt: new Date(),
        lastActive: new Date(),
        stats: {
          sessionsCreated: 0,
          chargesAdded: 0,
          revenueGenerated: 0,
          checkoutsProcessed: 0,
          auditActions: 0
        }
      };

      await db.collection(COLLECTIONS.USERS).updateOne(
        { deviceId },
        { $set: user },
        { upsert: true }
      );

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          success: true, 
          role, 
          sessionToken: sessionTokenNew,
          user 
        })
      };
    }

    if (action === 'verify') {
      const user = await db.collection(COLLECTIONS.USERS).findOne({
        sessionToken,
        expiresAt: { $gt: new Date() }
      });

      if (!user) {
        return {
          statusCode: 401,
          headers,
          body: JSON.stringify({ error: 'Invalid or expired token' })
        };
      }

      // Update last active
      await db.collection(COLLECTIONS.USERS).updateOne(
        { _id: user._id },
        { $set: { lastActive: new Date() } }
      );

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, user })
      };
    }

    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid action' })
    };
  } catch (error) {
    console.error('Auth function error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error', message: error.message })
    };
  }
};
