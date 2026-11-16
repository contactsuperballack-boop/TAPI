// Single active payment provider. Structured to match supplierRegistry.js —
// swap MockPaymentProvider for a real adapter once the Decision Gate
// resolves which provider TAPI actually integrates with. Nothing in
// routes/orders.routes.js or routes/payments.routes.js should need to
// change when that happens; only this file does.
const { MockPaymentProvider } = require("./adapters/mockPaymentProvider");

const paymentProvider = new MockPaymentProvider({
  webhookSecret: process.env.MOCK_PAYMENT_WEBHOOK_SECRET,
});

function getPaymentProvider() {
  return paymentProvider;
}

module.exports = { getPaymentProvider };
