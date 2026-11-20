// One definition of "a UUID" for request validation (versions 1-5 and nil/max-style ids are not needed: ours are random v4).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
module.exports = { UUID, isUuid: (v) => typeof v === "string" && UUID.test(v) };
