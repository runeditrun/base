// This reads only the fresh verifier's own D1; it is never bundled or served.
export default async function read({ database }) {
 const db = await database('DB');
 const row = await db.prepare('SELECT secret FROM fixture_installation WHERE id=1').first();
 return { DELIVERY_SECRET: row.secret };
}
