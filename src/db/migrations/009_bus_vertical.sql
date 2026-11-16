-- Bus vertical: reuse shared searches/offers/bookings while storing
-- bus-only operational details separately.
ALTER TABLE searches DROP CONSTRAINT searches_type_check;
ALTER TABLE searches ADD CONSTRAINT searches_type_check CHECK (type IN ('flight','hotel','bus'));

ALTER TABLE offers DROP CONSTRAINT offers_type_check;
ALTER TABLE offers ADD CONSTRAINT offers_type_check CHECK (type IN ('flight','hotel','bus'));

ALTER TABLE bookings DROP CONSTRAINT bookings_type_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_type_check CHECK (type IN ('flight','hotel','bus'));

CREATE TABLE bus_booking_details (
  booking_id            UUID PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  origin                TEXT NOT NULL,
  destination           TEXT NOT NULL,
  travel_date           DATE,
  pickup_point          TEXT,
  dropoff_point         TEXT,
  passengers            JSONB NOT NULL DEFAULT '[]'::jsonb,
  passenger_count       INTEGER NOT NULL CHECK (passenger_count > 0),
  seat_numbers          JSONB NOT NULL DEFAULT '[]'::jsonb,
  operator_booking_ref  TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bus_booking_details_route ON bus_booking_details(origin, destination, travel_date);
