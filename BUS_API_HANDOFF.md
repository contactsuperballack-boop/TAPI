# Bus API Layer Handoff

## Implemented

The TAPI MVP now includes a `/v1/buses` API family parallel to flights and hotels. It supports async search and polling, persisted offers, offer validation, idempotent booking, booking retrieval with supplier reconciliation, cancellation, and bus-specific booking details.

The default supplier is `mock_bus`, a deterministic local adapter intended for development and tests. Configure a future production adapter with `BUS_SUPPLIER_CODE` after implementing the `BusSupplier` contract.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/buses/search` | Start a route/date search |
| GET | `/v1/buses/search/:searchId` | Poll search and return persisted offers |
| GET | `/v1/buses/offers/:offerId` | Retrieve a bus offer |
| POST | `/v1/buses/offers/:offerId/validate` | Validate availability and price |
| POST | `/v1/buses/bookings` | Create an idempotent booking |
| GET | `/v1/buses/bookings/:bookingId` | Retrieve and reconcile status |
| POST | `/v1/buses/bookings/:bookingId/cancel` | Cancel a confirmed booking |

All endpoints use the existing agency API-key authentication, tenant isolation, rate limiting, audit middleware, error contract, booking state machine, and idempotency mechanism.

## Files added or changed

- `src/routes/buses.routes.js`
- `src/services/busSupplier.interface.js`
- `src/services/adapters/mockBusAdapter.js`
- `src/db/migrations/009_bus_vertical.sql`
- `tests/busSupplier.test.js`
- `src/app.js`
- `src/services/supplierRegistry.js`
- `src/validation/schemas.js`
- `src/repositories/index.js`
- `openapi.yaml`
- `README.md`

## Database

Run the normal migration command before using the bus routes:

```bash
npm run migrate
```

Migration `009_bus_vertical.sql` adds `bus` to the shared search, offer, and booking product constraints and creates `bus_booking_details` for route, travel date, passengers, seat numbers, boarding/drop-off points, and operator booking reference.

## Verification

The new bus adapter test passes, and all modified JavaScript files pass `node --check`. The complete test suite was attempted but the database-backed suites cannot run in the current sandbox because no PostgreSQL instance or `TEST_DATABASE_URL` is available. The pure unit suites, including `busSupplier.test.js`, pass.

## Production follow-up

Implement and sandbox-test a real bus supplier adapter. The adapter must define supplier-specific search, offer, seat-hold or availability semantics, booking, cancellation, and reconciliation behavior. The route layer should not need to change when that adapter is registered.

## Mobility operations layer

The project now includes `/v1/mobility` for operator-owned inventory and operations. It is separate from supplier-search routes because mobility inventory needs transactional seat ownership, holds, settlements, and operational state.

| Capability | Endpoint or mechanism |
|---|---|
| Dashboard summary | `GET /v1/mobility/dashboard/summary` |
| Operators | `POST /v1/mobility/operators` |
| Trip creation and inventory | `POST /v1/mobility/trips`, `GET /v1/mobility/trips` |
| Seat map | `GET /v1/mobility/trips/:tripId/seats` |
| Holds | `POST /v1/mobility/trips/:tripId/holds`, `POST /v1/mobility/holds/:holdId/release` |
| Bookings | `POST /v1/mobility/bookings`, `GET /v1/mobility/bookings`, `GET /v1/mobility/bookings/:bookingId` |
| Booking lifecycle | `POST /v1/mobility/bookings/:bookingId/transitions` |
| Integrations | `GET/POST /v1/mobility/integrations`, `PATCH /v1/mobility/integrations/:integrationId/status` |
| Settlements | `GET/POST /v1/mobility/settlements` |

Migration `010_mobility_operations.sql` creates `operators`, `trips`, `trip_seats`, `seat_holds`, `mobility_bookings`, `integrations`, `settlements`, and `audit_logs`.

Seat holds run inside a PostgreSQL transaction and lock the trip and requested seat rows with `FOR UPDATE`. Expired holds are released before a new hold is evaluated. Booking creation is tenant-scoped and idempotent through `(agency_id, idempotency_key)`, converts the active hold into booked seats atomically, and writes an audit record.

Booking transitions are explicitly guarded: `pending` may move to `confirmed` or `cancelled`, and `confirmed` may move to `boarded` or `cancelled`. Any invalid transition returns `409 INVALID_BOOKING_TRANSITION`.

The static operations console is served at `/console`. It stores the API key locally, reads dashboard/trip/booking/integration/settlement data from the live API, and clears server-derived views before each refresh so refresh controls reload current server state rather than retaining sample data.
