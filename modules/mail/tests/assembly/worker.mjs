import { doctorScenario } from './doctor-fixture.mjs';
export default {
  async fetch(request) {
    const input = await request.json();
    return Response.json(await doctorScenario(input.provider));
  },
};
