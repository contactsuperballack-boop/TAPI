// P1-6: explicit request validation. Previously routes did ad-hoc
// `if (!x) throw ...` checks that only covered a couple of fields and let
// anything else through unvalidated (wrong types, extra fields, malformed
// dates). These schemas are the single source of truth for what a valid
// request body looks like, and are also what OpenAPI (openapi.yaml) is
// generated/kept in sync against.
const { z } = require("zod");

const passengerCountsSchema = z.object({
  adults: z.number().int().min(1),
  children: z.number().int().min(0).optional(),
  infants: z.number().int().min(0).optional(),
});

const flightSearchSchema = z.object({
  origin: z.string().length(3, "origin must be a 3-letter IATA code"),
  destination: z.string().length(3, "destination must be a 3-letter IATA code"),
  departDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "departDate must be YYYY-MM-DD"),
  returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  passengers: passengerCountsSchema,
  cabinClass: z.enum(["economy", "premium", "business", "first"]).optional(),
  currency: z.string().length(3).optional(),
});

const travelerSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  passportNumber: z.string().optional(),
  passportCountry: z.string().length(2).optional(),
  passportExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  passportIssueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  nationality: z.string().length(2).optional(),
  gender: z.enum(["m", "f"]).optional(),
  email: z.string().email().optional(),
  phoneNumber: z.string().optional(),
  phoneCountry: z.string().length(2).optional(),
  passengerType: z.enum(["adult", "child", "infant"]).optional(),
  addressLine1: z.string().optional(),
  addressCity: z.string().optional(),
  addressPostal: z.string().optional(),
  addressCountry: z.string().length(2).optional(),
});

const flightBookingSchema = z.object({
  offerId: z.string().uuid(),
  passengers: z.array(travelerSchema).min(1),
  contact: z.object({
    email: z.string().email(),
    phone: z.string().optional(),
  }),
  travelerIds: z.array(z.string().uuid()).optional(),
  wantSeat: z.boolean().optional(),
  sandboxScenario: z.enum(["success", "price_change", "extra", "seller_failed", "needs_attention", "payment_declined", "payment_method_required", "temporarily_unavailable"]).optional(),
  sandboxSpeed: z.enum(["fast", "realistic"]).optional(),
});

/** Express middleware factory: validates req.body against a zod schema. */
function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const { Errors } = require("../domain/errors");
      return next(Errors.ValidationFailed(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")));
    }
    req.body = result.data;
    next();
  };
}

const hotelSearchSchema = z.object({
  destination: z.string().min(2, "destination is required"),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "checkIn must be YYYY-MM-DD"),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "checkOut must be YYYY-MM-DD"),
  guests: z.object({
    adults: z.number().int().min(1),
    children: z.number().int().min(0).optional(),
  }),
  rooms: z.number().int().min(1).optional(),
  currency: z.string().length(3).optional(),
}).refine((data) => data.checkOut > data.checkIn, { message: "checkOut must be after checkIn", path: ["checkOut"] });

const guestSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
});

const busSearchSchema = z.object({
  origin: z.string().min(2),
  destination: z.string().min(2),
  departDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "departDate must be YYYY-MM-DD"),
  passengers: z.number().int().min(1).max(20).optional().default(1),
  busType: z.string().min(1).optional(),
  departureTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  currency: z.string().length(3).optional(),
});

const busPassengerSchema = z.object({ firstName: z.string().min(1), lastName: z.string().min(1), seatPreference: z.string().optional() });
const busBookingSchema = z.object({
  offerId: z.string().uuid(),
  passengers: z.array(busPassengerSchema).min(1).max(20),
  contact: z.object({ email: z.string().email(), phone: z.string().optional() }),
  pickupPoint: z.string().min(1).optional(),
  dropoffPoint: z.string().min(1).optional(),
});

const hotelBookingSchema = z.object({
  offerId: z.string().uuid(),
  guests: z.array(guestSchema).min(1),
  contact: z.object({
    email: z.string().email(),
    phone: z.string().optional(),
  }),
});

const flightBookingAnswerSchema = z.object({
  round: z.number().int().positive(),
  confirm: z.literal(true).optional(),
  skip: z.literal(true).optional(),
  seats: z.array(z.object({ passenger: z.number().int().nonnegative(), designator: z.string().min(1) })).min(1).optional(),
}).refine((v) => [v.confirm, v.skip, v.seats].filter((x) => x !== undefined).length === 1, { message: "Provide exactly one of confirm, skip, or seats" });

const createOrderSchema = z.object({
  bookingIds: z.array(z.string().uuid()).min(1),
  customerId: z.string().uuid().optional(),
});

module.exports = { flightSearchSchema, flightBookingSchema, flightBookingAnswerSchema, hotelSearchSchema, hotelBookingSchema, busSearchSchema, busBookingSchema, createOrderSchema, validateBody };
