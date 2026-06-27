// netlify/functions/users.js
const { getDb, COLLECTIONS } = require('./shared-db');

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
    const { action, sessionToken, targetDeviceId, newRole } = body;

    // Verify admin/founder access
    const user = await db.collection(COLLECTIONS.USERS).findOne({
      sessionToken,
      expiresAt: { $gt: new Date() }
    });

    if (!user || (user.role !== 'admin' && user.role !== 'founder')) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ error: 'Forbidden' })
      };
    }

    if (action === 'updateRole') {
      await db.collection(COLLECTIONS.USERS).updateOne(
        { deviceId: targetDeviceId },
        { $set: { role: newRole, updatedAt: new Date() } }
      );

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true })
      };
    }

    if (action === 'list') {
      const users = await db.collection(COLLECTIONS.USERS)
        .find({}, { projection: { sessionToken: 0 } })
        .toArray();

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ users })
      };
    }

    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid action' })
    };
  } catch (error) {
    console.error('Users function error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error', message: error.message })
    };
  }
};
