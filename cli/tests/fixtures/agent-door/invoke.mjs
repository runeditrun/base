export default async function invoke({ name, args, who, worker }) {
 const jobs = await worker('NativeJobs');
 const id = await jobs.enqueue(name, args, who);
 for (let attempt = 0; attempt < 100; attempt++) {
  const result = await jobs.result(id);
  if (result) return result;
  await new Promise(resolve => setTimeout(resolve, 20));
 }
 throw new Error('Native queue delivery did not complete');
}
