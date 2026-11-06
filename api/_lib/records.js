// api/_lib/records.js
// Durable records (applications, enquiries, events, admin-added membership
// plans), stored in Upstash Redis. Every route imports record functions from
// here rather than from redis.js, so the storage layer has one entry point.

export {
  STATUS,
  normalizeStatus,
  listApplications,
  listApplicationSummaries,
  getApplicationStats,
  countApplications,
  getApplication,
  getApplicationByEmail,
  putApplication,
  updateApplication,
  listEnquiries,
  countEnquiries,
  putEnquiry,
  trimEnquiries,
  getEvent,
  putEvent,
  listEvents,
  deleteEvent,
  getEventAttendees,
  registerForEvent,
  confirmEventPayment,
  setAttendeeCheckIn,
  removeEventAttendee,
  listCustomPlans,
  insertCustomPlan,
  deleteCustomPlan,
  acquireLock,
  releaseLock,
  fencedWrite,
} from './redis.js';
