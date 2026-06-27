// netlify/functions/stats.js
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
    const { action, deviceId, sessionToken, statType, value } = body;

    // Verify session
    const user = await db.collection(COLLECTIONS.USERS).findOne({
      sessionToken,
      expiresAt: { $gt: new Date() }
    });

    if (!user) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Unauthorized' })
      };
    }

    if (action === 'increment') {
      const statField = `stats.${statType}`;
      
      await db.collection(COLLECTIONS.USERS).updateOne(
        { deviceId },
        { 
          $inc: { [statField]: value || 1 },
          $set: { lastActive: new Date() }
        }
      );

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true })
      };
    }

    if (action === 'get') {
      // Get all users stats for admin/founder view
      if (user.role === 'admin' || user.role === 'founder') {
        const allUsers = await db.collection(COLLECTIONS.USERS)
          .find({}, { projection: { deviceName: 1, role: 1, stats: 1, lastActive: 1 } })
          .toArray();

        // Calculate aggregated stats by role
        const roleStats = {
          staff: { count: 0, sessions: 0, charges: 0, revenue: 0 },
          founder: { count: 0, sessions: 0, charges: 0, revenue: 0 },
          admin: { count: 0, sessions: 0, charges: 0, revenue: 0 }
        };

        allUsers.forEach(u => {
          if (roleStats[u.role]) {
            roleStats[u.role].count++;
            roleStats[u.role].sessions += u.stats.sessionsCreated || 0;
            roleStats[u.role].charges += u.stats.chargesAdded || 0;
            roleStats[u.role].revenue += u.stats.revenueGenerated || 0;
          }
        });

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ 
            users: allUsers,
            roleStats,
            currentUser: user
          })
        };
      }

      // Regular users only see their own stats
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          user 
        })
      };
    }

    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid action' })
    };
  } catch (error) {
    console.error('Stats function error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error', message: error.message })
    };
  }
};
