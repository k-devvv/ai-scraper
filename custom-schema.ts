/**
 * examples/custom-schema.ts
 *
 * Shows how to pass a one-off Tool schema directly to scrapeOne()
 * without touching schemas.ts — useful for ad-hoc extractions.
 *
 * Run:  npx tsx examples/custom-schema.ts
 */

import * as dotenv from "dotenv";
dotenv.config();

import { scrapeOne } from "../src/scraper";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";

// Define a custom schema inline
const restaurantSchema: Tool = {
  name: "extract_restaurant",
  description: "Extract restaurant details from a food delivery or review page.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Restaurant name" },
      cuisine: {
        type: "array",
        items: { type: "string" },
        description: "Cuisine types (e.g. Italian, Sushi)",
      },
      rating: { type: "number", description: "Star rating out of 5" },
      price_range: {
        type: "string",
        description: "Price range indicator (e.g. $, $$, $$$)",
      },
      delivery_time_mins: {
        type: "number",
        description: "Estimated delivery time in minutes",
      },
      address: { type: "string", description: "Full street address" },
      menu_highlights: {
        type: "array",
        items: { type: "string" },
        description: "Featured or popular menu items",
      },
    },
    required: ["name", "cuisine"],
  },
};

(async () => {
  const result = await scrapeOne(
    "https://www.swiggy.com/", // swap for a real restaurant page URL
    {
      schema: restaurantSchema, // pass Tool object directly
      verbose: true,
    }
  );

  console.log("\n─── EXTRACTED ───");
  console.log(JSON.stringify(result.data, null, 2));
})();
