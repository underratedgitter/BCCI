# BCCI Event Broadcasting Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a complete Event Broadcasting Platform allowing BCCI Administrators to broadcast events with capacity, mode (online/offline), venue, and pricing (paid/unpaid) from the admin portal, and enabling website visitors/members to browse events and register with live capacity management on a dedicated public Events page.

**Architecture:** A Redis-backed events subsystem with atomic capacity tracking in `api/_lib/redis.js`, a REST API endpoint in `api/events.js` (and `server.js`), client store methods in `js/store.js`, an Admin Broadcasting tab in `index.html` and `js/app.js`, and a dedicated public `view-events` page with an interactive Attendee Registration Modal.

**Tech Stack:** Node.js, Upstash Redis, HTML5, Vanilla JavaScript (ES Modules), CSS3.

**Spec:** `docs/superpowers/specs/2026-09-05-event-broadcasting-platform-design.md`

## Global Constraints

- Never break existing functionality, routes, or test suites.
- Preserve zero additional external dependencies (leverage existing Upstash Redis and Node.js built-ins).
- Admin endpoints must require valid admin session tokens (`Authorization: Bearer <token>`).
- Live capacity limits must prevent overbooking and display clear "Sold Out" states.
- Support both Vercel serverless functions and VPS/Docker environments (`server.js`).

---

### Task 1: Redis Data Layer for Events

**Files:**
- Modify: `api/_lib/redis.js`
- Test: `tests/events-redis.test.mjs`

**Interfaces:**
- Produces:
  - `KEYS.event(id: string): string` -> `'bcci:event:<id>'`
  - `KEYS.eventIndex: string` -> `'bcci:event_index'`
  - `KEYS.eventAttendees(id: string): string` -> `'bcci:event_attendees:<id>'`
  - `listEvents({ limit?: number, offset?: number }): Promise<Array<Event>>`
  - `getEvent(id: string): Promise<Event|null>`
  - `putEvent(event: Event): Promise<Event>`
  - `deleteEvent(id: string): Promise<boolean>`
  - `getEventAttendees(id: string): Promise<Array<Attendee>>`
  - `registerForEvent(id: string, attendee: Attendee): Promise<{ success: boolean, event?: Event, error?: string }>`

- [x] **Step 1: Write the failing tests for Redis event helpers**
Create `tests/events-redis.test.mjs` testing `putEvent`, `listEvents`, `getEvent`, `registerForEvent` (including capacity limit and duplicate prevention), and `deleteEvent`.

- [x] **Step 2: Run test to verify it fails**
Run: `node tests/events-redis.test.mjs`
Expected: FAIL ("listEvents is not a function" or similar).

- [x] **Step 3: Implement Redis event helper methods in `api/_lib/redis.js`**
Add `KEYS.event`, `KEYS.eventIndex`, `KEYS.eventAttendees`, `listEvents`, `getEvent`, `putEvent`, `deleteEvent`, `getEventAttendees`, and `registerForEvent`.

- [x] **Step 4: Run test to verify it passes**
Run: `node tests/events-redis.test.mjs`
Expected: PASS with all tests passing.

---

### Task 2: Events REST API Endpoint (`api/events.js` and `server.js`)

**Files:**
- Create: `api/events.js`
- Modify: `server.js`
- Test: `tests/events-api.test.mjs`

**Interfaces:**
- Consumes: Redis methods from `api/_lib/redis.js`, HTTP utilities from `api/_lib/http.js`.
- Produces:
  - `GET /api/events`: public list of broadcasted events with `registeredCount` and `seatsLeft`.
  - `POST /api/events`: admin-only route creating events (`title`, `date`, `time`, `capacity`, `pricingType`, `fee`, `mode`, `venue`, `description`).
  - `DELETE /api/events?id=<id>`: admin-only deletion of events.
  - `POST /api/events?action=register`: public route joining an event with capacity limit checks.

- [x] **Step 1: Write failing tests for API endpoint**
Create `tests/events-api.test.mjs` simulating requests against handler:
- `GET /api/events` returns empty list or list of events.
- `POST /api/events` without admin auth returns 401.
- `POST /api/events` with admin auth and valid payload returns 201.
- `POST /api/events?action=register` successfully registers attendee and increments count.
- `POST /api/events?action=register` returns 409 when capacity is reached.
- `DELETE /api/events?id=...` with admin auth deletes the event.

- [x] **Step 2: Run test to verify it fails**
Run: `node tests/events-api.test.mjs`
Expected: FAIL ("Cannot find module '../api/events.js'").

- [x] **Step 3: Implement `api/events.js` and update `server.js`**
Write `api/events.js` with CORS, preflight, input validation, rate limiting, and error handling. Add route to `server.js`.

- [x] **Step 4: Run test to verify it passes**
Run: `node tests/events-api.test.mjs`
Expected: PASS with all tests passing.

---

### Task 3: Client Store Methods (`js/store.js`)

**Files:**
- Modify: `js/store.js`
- Test: `tests/client.test.mjs`

**Interfaces:**
- Produces:
  - `store.getEvents(): Promise<Array<Event>>`
  - `store.broadcastEvent(eventData: Object): Promise<Event>`
  - `store.deleteEvent(id: string): Promise<Object>`
  - `store.registerForEvent(id: string, attendeeData: Object): Promise<Object>`

- [x] **Step 1: Write failing assertions in `tests/client.test.mjs`**
Assert `store.getEvents`, `store.broadcastEvent`, `store.deleteEvent`, and `store.registerForEvent` exist on `Store.prototype`.

- [x] **Step 2: Run test to verify it fails**
Run: `node tests/client.test.mjs`
Expected: FAIL ("store has getEvents method").

- [x] **Step 3: Add event methods to `js/store.js`**
Implement the 4 methods on `Store` class delegating to `this.apiCall('/api/events', ...)`.

- [x] **Step 4: Run test to verify it passes**
Run: `node tests/client.test.mjs`
Expected: PASS.

---

### Task 4: Admin Portal Event Broadcasting UI (`index.html`, `js/app.js`, `css/styles.css`)

**Files:**
- Modify: `index.html`
- Modify: `js/app.js`
- Modify: `css/styles.css`
- Test: `tests/client.test.mjs`

**Interfaces:**
- Produces:
  - Admin sidebar tab `<li class="admin-menu-item" data-tab="events">`
  - Admin tab pane `#tab-events` with broadcast form (`#eventTitleInput`, `#eventDateInput`, `#eventTimeInput`, `#eventModeSelect`, `#eventVenueInput`, `#eventPricingSelect`, `#eventFeeInput`, `#eventCapacityInput`, `#eventDescInput`)
  - Broadcasted events table (`#adminEventsBody`) and mobile cards (`#adminEventsCards`)
  - Admin inspection modal for attendees (`data-inspect-event-id`)
  - Admin delete event handler (`data-delete-event-id`)

- [x] **Step 1: Add tests in `tests/client.test.mjs` for Admin Events UI**
Assert `#tab-events`, event form inputs, and `renderAdminEvents` function exist.

- [x] **Step 2: Run test to verify it fails**
Run: `node tests/client.test.mjs`
Expected: FAIL.

- [x] **Step 3: Update `index.html`, `js/app.js`, and `css/styles.css`**
1. Add `Event Broadcasting` tab to `.admin-menu` and `#tab-events` in `index.html`.
2. Implement `renderAdminEvents()`, broadcast form submit listener, fee field toggle, attendee inspection modal, and delete handler in `js/app.js`.
3. Add responsive styling in `css/styles.css` for event form, progress bars, and badges.

- [x] **Step 4: Run test to verify it passes**
Run: `node tests/client.test.mjs`
Expected: PASS.

---

### Task 5: Dedicated Public Events Page & Join Modal (`index.html`, `js/app.js`)

**Files:**
- Modify: `index.html`
- Modify: `js/app.js`
- Modify: `css/styles.css`
- Test: `tests/client.test.mjs`

**Interfaces:**
- Produces:
  - Top nav link `data-view-nav="events"`, drawer link, footer link
  - `#view-events` page with filter pills (All, In-Person Offline, Virtual Online, Free Entry) and search bar
  - Event cards grid (`#eventsGrid`) showing mode, fee, seats-left badges, and join buttons
  - Interactive "Register / Join Event" modal enforcing capacity and updating UI in real-time

- [x] **Step 1: Add tests in `tests/client.test.mjs` for public events page**
Assert `VIEW_PATHS.events` exists, `#view-events` exists in `index.html`, and event join modal operates with capacity constraints.

- [x] **Step 2: Run test to verify it fails**
Run: `node tests/client.test.mjs`
Expected: FAIL.

- [x] **Step 3: Implement public events view in `index.html` and `js/app.js`**
1. Add navigation links for `events` in desktop nav, mobile drawer, and footer in `index.html`.
2. Add `<main id="view-events" class="view-page">` container and grid in `index.html`.
3. Implement `renderEventsPage()`, search/filter listeners, and `showJoinEventModal(event)` in `js/app.js`.
4. Style event cards, pills, and capacity badges in `css/styles.css`.

- [x] **Step 4: Run test to verify it passes**
Run: `node tests/client.test.mjs`
Expected: PASS.

---

### Task 6: Full Verification & Integration Testing

**Files:**
- Test: `tests/client.test.mjs`
- Test: `tests/events-api.test.mjs`
- Test: Full project test suites

- [x] **Step 1: Run code syntax check**
Run: `npm run check`
Expected: `syntax OK`.

- [x] **Step 2: Run all test suites**
Run: `npm test`
Expected: 100% passing across all runners (e2e, api, data, purge, smtp, applicant-auth, client) with 0 failures.
