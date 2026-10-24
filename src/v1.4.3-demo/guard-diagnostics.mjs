// Fixed native guard literals from the isolated bootstrap. Only access-writer
// tables and its execution fence are included; no request error text is exported.
const guards = [
  {
    "guardCode": "g_00d83d3daef70c78",
    "message": "access grant is not backed by an applied payment",
    "tables": [
      "subscription_access_grants"
    ],
    "triggers": [
      "trg_subscription_access_grants_payment_guard"
    ]
  },
  {
    "guardCode": "g_01526b61ea5977a5",
    "message": "payment events are append-only",
    "tables": [
      "payment_events"
    ],
    "triggers": [
      "trg_payment_events_immutable_delete",
      "trg_payment_events_immutable_update"
    ]
  },
  {
    "guardCode": "g_1514363af454652e",
    "message": "v143_contract_binding_invalid",
    "tables": [
      "subscription_billing_contracts"
    ],
    "triggers": [
      "v143_contract_insert_binding"
    ]
  },
  {
    "guardCode": "g_1a1bc69c62a33257",
    "message": "subscription identity is immutable",
    "tables": [
      "subscriptions"
    ],
    "triggers": [
      "trg_subscriptions_identity_immutable"
    ]
  },
  {
    "guardCode": "g_23bc36bd659bbfdb",
    "message": "v143_operation_identity_append_only",
    "tables": [
      "subscription_payment_links"
    ],
    "triggers": [
      "v143_payment_link_no_delete",
      "v143_payment_link_no_update"
    ]
  },
  {
    "guardCode": "g_3f7e879e30a78404",
    "message": "v143_contract_update_invalid",
    "tables": [
      "subscription_billing_contracts"
    ],
    "triggers": [
      "v143_contract_update_binding"
    ]
  },
  {
    "guardCode": "g_465625b318903c8b",
    "message": "invalid subscription state transition",
    "tables": [
      "subscriptions"
    ],
    "triggers": [
      "trg_subscriptions_state_transition"
    ]
  },
  {
    "guardCode": "g_4f15531dd327e133",
    "message": "access grants cannot be deleted",
    "tables": [
      "subscription_access_grants"
    ],
    "triggers": [
      "trg_subscription_access_grants_no_delete"
    ]
  },
  {
    "guardCode": "g_51a9ffc5bd9740f3",
    "message": "order price snapshot is not server-approved",
    "tables": [
      "subscription_orders"
    ],
    "triggers": [
      "trg_subscription_orders_price_guard"
    ]
  },
  {
    "guardCode": "g_6697bbc47cac75d8",
    "message": "payment orders cannot be deleted",
    "tables": [
      "subscription_orders"
    ],
    "triggers": [
      "trg_subscription_orders_no_delete"
    ]
  },
  {
    "guardCode": "g_702ec329a3966f0a",
    "message": "invalid order state transition",
    "tables": [
      "subscription_orders"
    ],
    "triggers": [
      "trg_subscription_orders_state_transition"
    ]
  },
  {
    "guardCode": "g_7b85e898aad2855c",
    "message": "order identity and price snapshot are immutable",
    "tables": [
      "subscription_orders"
    ],
    "triggers": [
      "trg_subscription_orders_identity_immutable"
    ]
  },
  {
    "guardCode": "g_849415b62f844f1d",
    "message": "v143_outgoing_link_binding_invalid",
    "tables": [
      "subscription_payment_links"
    ],
    "triggers": [
      "v143_payment_link_outgoing_binding"
    ]
  },
  {
    "guardCode": "g_87f4a753de2e2608",
    "message": "subscriptions cannot be deleted",
    "tables": [
      "subscriptions"
    ],
    "triggers": [
      "trg_subscriptions_no_delete"
    ]
  },
  {
    "guardCode": "g_8922b5b3df31c950",
    "message": "access grant identity is immutable",
    "tables": [
      "subscription_access_grants"
    ],
    "triggers": [
      "trg_subscription_access_grants_identity_immutable"
    ]
  },
  {
    "guardCode": "g_9188e55eb4f1fcf8",
    "message": "subscription history is append-only",
    "tables": [
      "subscription_status_history"
    ],
    "triggers": [
      "trg_subscription_history_immutable_delete",
      "trg_subscription_history_immutable_update"
    ]
  },
  {
    "guardCode": "g_9315f920889962d3",
    "message": "v143_payment_link_binding_invalid",
    "tables": [
      "subscription_payment_links"
    ],
    "triggers": [
      "v143_payment_link_incoming_binding"
    ]
  },
  {
    "guardCode": "g_b8755a4d97445c05",
    "message": "v143_contract_retains_evidence",
    "tables": [
      "subscription_billing_contracts"
    ],
    "triggers": [
      "v143_contract_no_delete"
    ]
  },
  {
    "guardCode": "g_baf4e12fc3afb24b",
    "message": "subscription extension lacks an applied referral bonus",
    "tables": [
      "subscriptions"
    ],
    "triggers": [
      "trg_subscriptions_referral_extension_guard"
    ]
  },
  {
    "guardCode": "g_d3a67a0af2adbe33",
    "message": "settled access grant cannot be rewritten",
    "tables": [
      "subscription_access_grants"
    ],
    "triggers": [
      "trg_subscription_access_grants_no_rewrite"
    ]
  },
  {
    "guardCode": "g_ec7de2afbe099b8c",
    "message": "access compensation does not match its payment",
    "tables": [
      "subscription_access_grants"
    ],
    "triggers": [
      "trg_subscription_access_grants_compensation_guard"
    ]
  },
  {
    "guardCode": "g_fdcda9588dd9b8e9",
    "message": "invalid access grant state transition",
    "tables": [
      "subscription_access_grants"
    ],
    "triggers": [
      "trg_subscription_access_grants_transition"
    ]
  }
];

export const DEMO_GUARD_CODES = Object.freeze(guards.map(entry => entry.guardCode));
export const DEMO_GUARD_LOOKUP = Object.freeze(guards.map(({message, ...entry}) => Object.freeze(entry)));
export function matchDemoGuard(text) {
  if (typeof text !== 'string') return null;
  return guards.find(entry => text.includes(entry.message))?.guardCode ?? null;
}
