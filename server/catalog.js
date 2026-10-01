// Trusted server-side product map. The browser only ever sends a slug.
// Amounts are in cents and must match the Stripe Price for each product.
export const PRODUCTS = {
  '3-week-look-ahead': {
    name: 'Fieldstone 3-Week Look-Ahead',
    amount: 2900,
    priceEnv: 'STRIPE_PRICE_3_WEEK_LOOK_AHEAD',
    file: 'Fieldstone_3_Week_Look_Ahead_v1_0.zip',
  },
  'bid-leveling-matrix': {
    name: 'Fieldstone Bid Leveling Matrix',
    amount: 2900,
    priceEnv: 'STRIPE_PRICE_BID_LEVELING_MATRIX',
    file: 'Fieldstone_Bid_Leveling_Matrix_v1_0.zip',
  },
  'superintendent-project-toolkit': {
    name: 'Fieldstone Superintendent Project Toolkit',
    amount: 6900,
    priceEnv: 'STRIPE_PRICE_SUPERINTENDENT_PROJECT_TOOLKIT',
    file: 'Fieldstone_Superintendent_Project_Toolkit_v1_0.zip',
  },
  'construction-management-bundle': {
    name: 'Fieldstone Construction Management Bundle',
    amount: 9900,
    priceEnv: 'STRIPE_PRICE_CONSTRUCTION_MANAGEMENT_BUNDLE',
    file: 'Fieldstone_Construction_Management_Bundle_v1_0.zip',
  },
};
export const CURRENCY = 'usd';
