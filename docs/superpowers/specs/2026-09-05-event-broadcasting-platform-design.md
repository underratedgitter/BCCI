# BCCI Event Broadcasting Platform & Attendee Management

**Date:** 2026-09-05  
**Status:** Approved  
**Scope:** Admin Event Broadcasting & Public Website Events Subsystem  

---

## 1. Overview & Objectives

Bharuch Chamber of Commerce & Industry (BCCI) organizes trade conclaves, industrial webinars, government policy dialogues, and MSME training workshops. Currently, media items exist only as static press gallery posts.

This specification introduces an **Event Broadcasting Platform** that empowers BCCI Administrators to schedule, publish, and manage events, and allows website visitors and members to view details and register:
1. **Admin Event Broadcasting**: Create and publish events directly from the Admin Approval Portal (`view-admin`) with full control over:
   - Event Title / Name
   - Date & Time schedule
   - Attendance Capacity (`capacity`: maximum number of attendees that can join)
   - Pricing Type (`pricingType`: Free / Unpaid vs. Paid with ticket fee)
   - Event Mode (`mode`: In-Person Offline vs. Virtual Online)
   - Venue / Meeting Address or Link
   - Detailed Agenda & Overview
2. **Real-Time Capacity Enforcement**: Tracks live attendee registrations against the maximum capacity limit, showing remaining seats and preventing overbooking ("Housefull / Sold Out" state).
3. **Dedicated Public Events Page (`view-events`)**: Accessible from the desktop navigation, mobile drawer, and footer, featuring filter tabs (All, In-Person Offline, Virtual Online, Upcoming), search, and high-contrast responsive event cards.
4. **Interactive Attendee Registration Modal**: Allows visitors and verified members to reserve a seat with Name, Email, Phone, and Enterprise affiliation.
5. **Admin Management & Attendee Inspection**: Administrators can monitor live registration figures, inspect attendee lists per event, and cancel/delete events when concluded.
6. **Zero Regressions**: Maintains existing admin features (applications approval, enquiry inbox, member directory, CSV export) and passes 100% of all existing test suites.

---

## 2. Architecture & Data Model

### 2.1 Redis Key Layout (`api/_lib/redis.js`)

- **Event Record Key**: `bcci:event:<id>`
  - `<id>` format: `EVT-<timestamp-base36>-<hex4>` (e.g. `EVT-M2Y8Q1-7B3A`)
  - JSON payload:
    ```json
    {
      "id": "EVT-M2Y8Q1-7B3A",
      "title": "Annual Gujarat Chemical Industry Conclave 2026",
      "date": "2026-10-15",
      "time": "10:00 AM - 02:00 PM",
      "mode": "offline",
      "venue": "BCCI Auditorium, Station Road, Bharuch",
      "pricingType": "free",
      "fee": 0,
      "capacity": 150,
      "registeredCount": 42,
      "description": "High-level industrial policy conclave on sustainable manufacturing and green chemical technologies.",
      "status": "published",
      "createdBy": "admin@bccibharuch.in",
      "createdAt": "2026-09-05T10:00:00.000Z",
      "updatedAt": "2026-09-05T10:00:00.000Z"
    }
    ```
- **Events Sorted Set Index**: `bcci:event_index`
  - Score: Event Unix timestamp (or date timestamp for upcoming order)
  - Member: Event ID (`EVT-...`)
- **Event Attendees List**: `bcci:event_attendees:<id>`
  - Key holding array or set of registered attendee objects:
    ```json
    [
      {
        "name": "Rajesh Patel",
        "email": "rajesh@example.com",
        "phone": "9825012345",
        "company": "Gujarat Organics Ltd",
        "registeredAt": "2026-09-05T10:30:00.000Z"
      }
    ]
    ```

### 2.2 Redis Helper Functions in `api/_lib/redis.js`

- `listEvents({ limit, offset })`: Retrieves events in order from `bcci:event_index`, fetches JSON values via `mget`, attaches attendee count, and returns normalized event array.
- `getEvent(id)`: Returns single event object.
- `putEvent(event)`: Saves `bcci:event:<id>` and adds to `bcci:event_index`.
- `deleteEvent(id)`: Deletes `bcci:event:<id>`, removes from `bcci:event_index`, and cleans up `bcci:event_attendees:<id>`.
- `getEventAttendees(id)`: Returns array of attendee records.
- `registerForEvent(id, attendee)`: Atomically checks remaining capacity (`registeredCount < capacity`). If valid, appends attendee to `bcci:event_attendees:<id>`, increments `registeredCount` on the event object, and returns `{ success: true, event }`. If full, returns `{ success: false, error: "Event has reached maximum capacity." }`.

---

## 3. API Endpoints (`api/events.js`)

Supported HTTP methods: `GET, POST, DELETE, OPTIONS`. CORS enabled.

### 3.1 `GET /api/events` (Public)
- **Parameters (query)**: `id` (optional single event lookup), `includeAttendees=true` (admin only).
- **Response**: `{ success: true, events: [...] }`
- Each event returns public fields including `registeredCount` and `seatsLeft: Math.max(0, capacity - registeredCount)`.

### 3.2 `POST /api/events` (Admin-Only Event Creation)
- **Authentication**: Requires valid admin session token in `Authorization: Bearer <token>`.
- **Validation**:
  - `title`: string, >= 3 characters, <= 200 characters.
  - `date`: valid date string (YYYY-MM-DD).
  - `time`: non-empty string (e.g. `10:00 AM`).
  - `capacity`: integer >= 1, <= 50000.
  - `pricingType`: `'unpaid'` / `'free'` or `'paid'`.
  - `fee`: if paid, non-negative number >= 1; if unpaid, `0`.
  - `mode`: `'online'` or `'offline'`.
  - `venue`: string, >= 3 characters. (For online: e.g. "Zoom Webinar / Google Meet Link provided to registered attendees").
  - `description`: string, >= 5 characters.
- **Response**: HTTP 201 `{ success: true, event, message: "Event broadcasted successfully." }`.

### 3.3 `POST /api/events?action=register` (Public Attendee Registration)
- **Rate Limit**: 5 registrations per minute per IP.
- **Validation**:
  - `eventId`: must exist and have `status: 'published'`.
  - `name`: >= 2 characters.
  - `email`: valid email format.
  - `phone`: valid 10-digit Indian mobile number (`/^[6-9]\d{9}$/`).
  - `company`: string (optional, defaults to "Independent / Delegate").
- **Flow**:
  1. Check if event is at capacity. If `registeredCount >= capacity`, return HTTP 409 `{ success: false, error: "This event is currently full (Capacity reached)." }`.
  2. Check if email already registered for this event. If so, return HTTP 409 `{ success: false, error: "You are already registered for this event." }`.
  3. Append attendee, increment count.
  4. Return HTTP 200 `{ success: true, message: "Registration confirmed! We look forward to seeing you.", event }`.

### 3.4 `DELETE /api/events?id=<id>` (Admin-Only Deletion)
- **Authentication**: Requires valid admin session token.
- **Flow**: Removes event record and attendee list from Redis.
- **Response**: HTTP 200 `{ success: true, message: "Event removed." }`.

### 3.5 VPS / Docker Server Integration (`server.js`)
- Route `/api/events` registered in `server.js` matching standard endpoint dispatch pattern.

---

## 4. Admin Portal UI (`view-admin`)

### 4.1 New Sidebar Menu Tab
In `index.html` under `.admin-menu`:
```html
<li class="admin-menu-item" data-tab="events">
  <i class="fas fa-bullhorn"></i> Event Broadcasting
</li>
```

### 4.2 Tab Content (`#tab-events`)
Divided into two clean sections:
1. **"Broadcast New Event" Form**:
   - Event Title input (`#eventTitleInput`)
   - Schedule inputs: Event Date (`#eventDateInput`), Event Time (`#eventTimeInput`)
   - Mode selector: In-Person Offline vs Online Webinar (`#eventModeSelect`)
   - Venue / Address / Online URL (`#eventVenueInput`)
   - Pricing selector: Free / Complimentary vs Paid Entry (`#eventPricingSelect`)
   - Ticket Fee (INR) input (`#eventFeeInput`, toggled visible when Paid is selected)
   - Max Capacity / Attendance Limit (`#eventCapacityInput`, number input, min 1)
   - Overview & Topics Covered (`#eventDescInput`, textarea)
   - Submit Button: `<button id="btnSubmitBroadcast"><i class="fas fa-broadcast-tower"></i> Broadcast Event to Website</button>`
2. **"Active Broadcasted Events" Table & Mobile Cards**:
   - Table columns: `Event Title & Mode`, `Date & Time`, `Venue`, `Fee`, `Attendance Capacity`, `Actions`.
   - Attendance column shows progress bar and count: e.g., `42 / 100 Joined (58 left)`.
   - Actions:
     - **Inspect Attendees** (`data-inspect-event-id`): Opens modal listing all registered attendee names, emails, phones, and companies with option to export/copy list.
     - **Delete / Cancel Event** (`data-delete-event-id`): Prompts confirmation and removes the broadcast.

---

## 5. Public Website UI (`view-events`)

### 5.1 Navigation Updates
- **Desktop Header Navigation**: Add `<li><a href="#" class="nav-link" data-view-nav="events">Events</a></li>`
- **Mobile Drawer Menu**: Add `<li><a href="#" class="mobile-drawer-link" data-view-nav="events"><i class="fas fa-calendar-alt"></i> Events &amp; Conclaves</a></li>`
- **Footer Links**: Add `<li><a href="#" data-view-nav="events">Events &amp; Conclaves</a></li>`

### 5.2 Dedicated Page View (`#view-events`)
- **Header**: Section Tag: `Official Conclaves & Seminars`, Section Title: `BCCI Events & Conclaves`, Subtitle: `Join industry leaders, policymakers, and trade delegates across Bharuch's premier events.`
- **Filter & Search Bar**:
  - Search input for event name or venue.
  - Quick filter pills: `All Events`, `In-Person (Offline)`, `Virtual (Online)`, `Free Entry`.
- **Events Grid (`#eventsGrid`)**:
  - Dynamically renders event cards.
  - Card anatomy:
    - Top badges: Mode pill (`🏛️ In-Person` or `🌐 Online Webinar`), Pricing pill (`Free` or `₹500`), Seats pill (`XX seats left` or `Sold Out`).
    - Title: Bold, prominent heading.
    - Meta info: Calendar icon with formatted date & time; Location pin with Venue name / meeting link note.
    - Description: Summary of the session and speakers.
    - Action button:
      - When seats available: `<button class="btn-primary btn-join-event" data-event-id="..."><i class="fas fa-ticket-alt"></i> Register / Join Event</button>`
      - When capacity reached: `<button class="btn-secondary" disabled style="opacity: 0.6;"><i class="fas fa-ban"></i> Capacity Reached (Sold Out)</button>`

### 5.3 Event Join / Registration Modal
When a visitor or member taps **Register / Join Event**:
- Opens BCCI branded modal (`showModal`):
  - Displays Event Name, Date, Venue, and Fee info.
  - Registration Form:
    - Full Name (`#joinEventName`, required)
    - Official Email (`#joinEventEmail`, required, pre-filled if applicant session exists)
    - Contact Phone (`#joinEventPhone`, required, 10 digits)
    - Company / Organization Name (`#joinEventCompany`, optional)
  - Submit Button: `<button class="btn-primary" id="btnConfirmJoinEvent"><i class="fas fa-check-circle"></i> Confirm Free Registration</button>` (or `Confirm Registration`)
  - Submitting sends `POST /api/events?action=register`, shows confirmation toast with reservation reference, and updates the remaining seats badge in real time.

---

## 6. Store Client (`js/store.js`)

Add native API client methods:
- `getEvents()`: calls `GET /api/events`
- `broadcastEvent(eventData)`: calls `POST /api/events` with `auth: 'admin'`
- `deleteEvent(id)`: calls `DELETE /api/events?id=${id}` with `auth: 'admin'`
- `registerForEvent(id, attendeeData)`: calls `POST /api/events?action=register` with body `{ eventId: id, ...attendeeData }`

---

## 7. App Controller (`js/app.js`)

- Add `events` to `VIEW_PATHS` and `PAGE_TITLES`.
- Wire `renderView('events')` to call `renderEventsPage()`.
- Add `renderAdminEvents()` into `renderAdminPortal()`.
- Bind event creation form submission with validation.
- Bind event attendee inspection and event deletion.
- Bind public event registration modal and submission.

---

## 8. Verification & Test Plan

1. **Unit & Functional Tests (`tests/client.test.mjs`)**:
   - Static DOM assertions: Navigation links exist in header, mobile drawer, and footer.
   - Admin event form controls exist with validation rules (`eventName`, `capacity` >= 1, `mode`, `pricingType`, `venue`).
   - Event cards render correct status badges (Online, Offline, Free, Paid, Seats Available, Sold Out).
   - Event registration validates attendee inputs and handles capacity limits.
2. **API Endpoint Tests (`tests/events.test.mjs` or `tests/api.test.mjs`)**:
   - `GET /api/events` returns list of events.
   - `POST /api/events` requires admin authentication; creates event when valid.
   - `POST /api/events?action=register` registers attendee and decrements available spots; prevents duplicate registration with same email.
   - `POST /api/events?action=register` returns 409 when capacity is reached.
   - `DELETE /api/events` requires admin authentication; deletes event.
3. **Regression Suite**:
   - `npm run check` (syntax check on all modules).
   - Full `npm test` suite must pass with 0 errors across existing E2E, Admin Auth, Client, and Purge suites.
