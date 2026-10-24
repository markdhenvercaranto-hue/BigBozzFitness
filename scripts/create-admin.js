const crypto = require('crypto');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const { createDatabase } = require('../database');

dotenv.config();

const username = process.argv[2] || process.env.ADMIN_USERNAME || 'owner';

async function createOwner() {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/.test(username)) {
    throw new Error('Choose a username 3–32 characters long using letters, numbers, dots, underscores, or hyphens.');
  }

  const database = createDatabase();
  try {
    await database.initialize();
    const legacyPasswordHash = await database.getAdminPasswordHash();
    if (!legacyPasswordHash && (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12 || process.env.ADMIN_PASSWORD.length > 1024)) {
      throw new Error('Set ADMIN_PASSWORD to a password between 12 and 1,024 characters for initial owner setup.');
    }
    const passwordHash = legacyPasswordHash || (process.env.ADMIN_PASSWORD
      ? await bcrypt.hash(process.env.ADMIN_PASSWORD, 12)
      : null);
    await database.createFirstAdmin({
      id: crypto.randomUUID(),
      username,
      passwordHash
    });
    console.log(`Created the initial owner account "${username}".`);
    console.log('Sign in and enroll an authenticator. Remove ADMIN_PASSWORD from the environment after setup.');
  } catch (error) {
    throw error;
  } finally {
    await database.close();
  }
}

createOwner().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
