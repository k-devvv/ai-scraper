/**
 * selectors.ts
 * CSS selector rule registry for every schema.
 * Upgraded: pricing selectors massively expanded, all schemas improved.
 */

export type FieldRule =
  | { type: "text"; selectors: string[] }
  | { type: "attr"; selectors: string[]; attr: string }
  | { type: "bool"; selectors: string[]; trueValues?: string[] }
  | { type: "number"; selectors: string[] }
  | { type: "list"; selectors: string[]; limit?: number }
  | { type: "table"; selectors: string[] }
  | { type: "rating"; selectors: string[] };

export type SchemaRules = Record<string, FieldRule>;

export const WORD_RATINGS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  One: 1, Two: 2, Three: 3, Four: 4, Five: 5,
};

// ─── Product ──────────────────────────────────────────────────────────────────

export const productRules: SchemaRules = {
  product_name: {
    type: "text",
    selectors: [
      "h1.product_title", "h1#productTitle", "h1.product-title",
      ".product-name h1", ".product-single__title", "h1.entry-title",
      '[itemprop="name"]', ".product__title", ".pdp-title", "h1",
    ],
  },
  price: {
    type: "number",
    selectors: [
      "p.price_color", ".price_color",
      ".woocommerce-Price-amount bdi",
      ".woocommerce-Price-amount",
      "#priceblock_ourprice", "#priceblock_dealprice",
      ".price--main", '[itemprop="price"]',
      ".product-price .amount", ".product-price",
      ".price ins .amount", ".price .amount",
      "[data-price]", ".price",
    ],
  },
  original_price: {
    type: "number",
    selectors: [
      ".woocommerce-Price-amount del bdi",
      ".woocommerce-Price-amount del",
      ".price--compare", ".compare-at-price",
      "#listPrice", ".a-text-strike",
    ],
  },
  currency: {
    type: "text",
    selectors: [
      '[itemprop="priceCurrency"]',
      ".woocommerce-Price-currencySymbol",
      ".currency-symbol",
    ],
  },
  in_stock: {
    type: "bool",
    selectors: [
      ".instock", ".instock.availability", ".stock",
      ".woocommerce-stock", "#availability",
      '[itemprop="availability"]', ".product-availability",
      ".stock-status", ".availability",
    ],
    trueValues: ["in stock", "instock", "available", "add to cart", "buy now", "in-stock"],
  },
  description: {
    type: "text",
    selectors: [
      "article.product_page > p",
      "#product-description > p",
      "#tab-description p",
      ".woocommerce-product-details__short-description",
      "#productDescription p",
      '[itemprop="description"]',
      ".product-description p",
      ".product__description p",
      ".product-description",
      ".product__description",
    ],
  },
  sku: {
    type: "text",
    selectors: ['[itemprop="sku"]', ".sku", ".product-sku", "#product_sku", ".product-meta__sku"],
  },
  brand: {
    type: "text",
    selectors: [
      '[itemprop="brand"] [itemprop="name"]',
      '[itemprop="brand"]',
      ".brand", "#bylineInfo",
      ".product-meta__vendor", ".product-brand",
    ],
  },
  rating: {
    type: "rating",
    selectors: [
      "p.star-rating", ".star-rating",
      '[itemprop="ratingValue"]',
      ".a-icon-star span",
      ".woocommerce-product-rating .rating",
      ".product-rating .rating",
    ],
  },
  review_count: {
    type: "number",
    selectors: [
      '[itemprop="reviewCount"]',
      ".woocommerce-review-link",
      "#acrCustomerReviewText",
      ".review-count", ".rating-count",
    ],
  },
  features: {
    type: "table",
    selectors: [
      "table.table", "table.product_attributes",
      "#productDetails_techSpec_section_1 tr",
      "#feature-bullets li",
      ".product-features li",
      ".woocommerce-product-attributes tr",
      ".product-specs tr",
    ],
  },
  images: {
    type: "list",
    selectors: [
      ".woocommerce-product-gallery img",
      "#imgTagWrapperId img",
      ".product__media img",
      "[data-zoom-image]",
      ".product-image img",
      ".product-gallery img",
    ],
    limit: 5,
  },
};

// ─── Article ──────────────────────────────────────────────────────────────────

export const articleRules: SchemaRules = {
  title: {
    type: "text",
    selectors: [
      "h1.post-title", "h1.entry-title", "h1.article-title",
      '[itemprop="headline"]', "article h1", "h1",
    ],
  },
  author: {
    type: "text",
    selectors: [
      '[itemprop="author"] [itemprop="name"]',
      '[itemprop="author"]',
      ".author-name", ".byline",
      '[rel="author"]', ".post-author",
    ],
  },
  published_date: {
    type: "text",
    selectors: [
      'time[itemprop="datePublished"]',
      '[itemprop="datePublished"]',
      "time[datetime]",
      ".post-date", ".entry-date", ".article-date",
    ],
  },
  summary: {
    type: "text",
    selectors: [
      ".post-excerpt",
      '[itemprop="description"]',
      "article p:first-of-type",
    ],
  },
  content: {
    type: "text",
    selectors: [
      "article .entry-content",
      ".post-content",
      '[itemprop="articleBody"]',
      "article",
      "main",
    ],
  },
  tags: {
    type: "list",
    selectors: [".post-tags a", ".tags a", '[rel="tag"]', ".article-tags a"],
    limit: 10,
  },
  key_points: {
    type: "list",
    selectors: ["article h2", "article h3", ".key-points li", ".summary li"],
    limit: 10,
  },
  word_count: {
    type: "number",
    selectors: [".word-count", "[data-word-count]"],
  },
};

// ─── Job Listing ──────────────────────────────────────────────────────────────

export const jobRules: SchemaRules = {
  title: {
    type: "text",
    selectors: ["h1.posting-headline", ".job-title", '[itemprop="title"]', "h1"],
  },
  company: {
    type: "text",
    selectors: [".company-name", '[itemprop="hiringOrganization"] [itemprop="name"]', ".employer"],
  },
  location: {
    type: "text",
    selectors: [".location", '[itemprop="jobLocation"]', ".job-location"],
  },
  salary: {
    type: "text",
    selectors: [".salary", '[itemprop="baseSalary"]', ".compensation", ".pay"],
  },
  job_type: {
    type: "text",
    selectors: [".employment-type", ".job-type", '[itemprop="employmentType"]'],
  },
  description: {
    type: "text",
    selectors: [".posting-description", ".job-description", '[itemprop="description"]'],
  },
  skills: {
    type: "list",
    selectors: [
      ".posting-requirements li", ".requirements li",
      ".skills li", ".qualifications li",
    ],
    limit: 15,
  },
  responsibilities: {
    type: "list",
    selectors: [".posting-requirements li", ".responsibilities li", ".duties li"],
    limit: 10,
  },
};

// ─── SaaS / AI Ideas ──────────────────────────────────────────────────────────

export const saasIdeasRules: SchemaRules = {
  page_title: {
    type: "text",
    selectors: [
      "h1.gh-article-title",
      "h1.article-title",
      "h1",
      "title",
    ],
  },
  ideas: {
    type: "list",
    selectors: [
      ".gh-content h2", ".gh-content h3",
      ".post-content h2", ".post-content h3",
      "article .content h2", "article .content h3",
      ".gh-card-title", ".post-card-title",
      ".article-card h2",
      "article h2", "article h3",
      "main h2", "main h3",
    ],
    limit: 30,
  },
  summary: {
    type: "text",
    selectors: [
      ".gh-article-excerpt",
      ".post-card-excerpt",
      ".gh-content > p:first-of-type",
      ".post-content > p:first-of-type",
      "article p:first-of-type",
      "main p:first-of-type",
    ],
  },
  categories: {
    type: "list",
    selectors: [
      ".gh-article-tag", ".post-card-tags",
      ".article-tag", ".post-tag",
      "a.tag", ".tags a", '[rel="tag"]',
      ".category a", ".label",
    ],
    limit: 10,
  },
  author: {
    type: "text",
    selectors: [
      ".gh-article-author-name",
      ".author-name", ".post-author-name",
      '[itemprop="author"]', '[rel="author"]',
      ".byline", ".author",
    ],
  },
  published_date: {
    type: "text",
    selectors: [
      "time[datetime]",
      ".gh-article-meta time",
      ".post-date", ".entry-date",
      '[itemprop="datePublished"]',
    ],
  },
  tools_mentioned: {
    type: "list",
    selectors: [
      ".gh-content code",
      ".post-content code",
      "article code",
      ".kg-code-card code",
      "code",
    ],
    limit: 20,
  },
};

// ─── Blog Post ────────────────────────────────────────────────────────────────

export const blogRules: SchemaRules = {
  title: { type: "text", selectors: ["h1"] },
  author: {
    type: "text",
    selectors: ["[rel='author']", ".author", ".byline", '[itemprop="author"]'],
  },
  date: {
    type: "text",
    selectors: ["time[datetime]", ".date", ".published", '[itemprop="datePublished"]'],
  },
  tags: {
    type: "list",
    selectors: [".tags a", ".categories a", '[rel="tag"]'],
    limit: 10,
  },
  tools_mentioned: {
    type: "list",
    selectors: ["code", ".tool", ".integration", "a[href*='github']"],
    limit: 15,
  },
  summary: {
    type: "text",
    selectors: ["article p:first-of-type", ".excerpt", "meta[name='description']"],
  },
};

// ─── Company Profile ──────────────────────────────────────────────────────────

export const companyRules: SchemaRules = {
  name: { type: "text", selectors: ["h1", ".company-name", '[itemprop="name"]'] },
  description: {
    type: "text",
    selectors: [".company-description", ".about", '[itemprop="description"]', "p:first-of-type"],
  },
  founded: {
    type: "text",
    selectors: [".founded", '[itemprop="foundingDate"]', ".year-founded"],
  },
  funding: { type: "text", selectors: [".funding", ".raised", ".total-funding"] },
  employees: { type: "text", selectors: [".employees", ".team-size", ".headcount"] },
  website: {
    type: "attr",
    selectors: ["[itemprop='url']", ".website a", ".company-url"],
    attr: "href",
  },
  products: {
    type: "list",
    selectors: [".products li", ".services li", ".solutions li"],
    limit: 10,
  },
  competitors: {
    type: "list",
    selectors: [".competitors li", ".alternatives li", ".similar-companies li"],
    limit: 10,
  },
};

// ─── Pricing Page ─────────────────────────────────────────────────────────────
// Greatly expanded — covers Tailwind/CSS-module class patterns used by
// Next.js SaaS sites (n8n, Vercel, Linear, etc.)

export const pricingRules: SchemaRules = {
  product_name: {
    type: "text",
    selectors: [
      "h1",
      ".pricing-title",
      ".pricing-header h1",
      "[class*='pricing'] h1",
      "[class*='plans'] h1",
    ],
  },

  // Tier names — the most important field
  tiers: {
    type: "list",
    selectors: [
      // Generic semantic selectors
      "[class*='plan'] h2",
      "[class*='plan'] h3",
      "[class*='tier'] h2",
      "[class*='tier'] h3",
      "[class*='pricing'] h2",
      "[class*='pricing'] h3",
      "[class*='card'] h2",
      "[class*='card'] h3",

      // Common class names used by popular SaaS sites
      ".plan-name",
      ".tier-name",
      ".plan-title",
      ".pricing-plan h3",
      ".pricing-plan h2",
      ".pricing-card h2",
      ".pricing-card h3",
      ".pricing-table th",
      ".plan-header h2",
      ".plan-header h3",

      // Data attributes
      "[data-plan-name]",
      "[data-tier]",
    ],
    limit: 10,
  },

  // Raw price strings — kept as list for structured parsing in heuristics
  prices: {
    type: "list",
    selectors: [
      "[class*='plan'] [class*='price']",
      "[class*='tier'] [class*='price']",
      "[class*='pricing'] [class*='price']",
      "[class*='pricing'] [class*='amount']",
      ".plan-price",
      ".tier-price",
      ".price-value",
      ".pricing-amount",
      ".price-number",
      "[class*='price'] .amount",
      "[data-price]",
    ],
    limit: 10,
  },

  // All features across all plans
  features: {
    type: "list",
    selectors: [
      "[class*='plan'] li",
      "[class*='tier'] li",
      "[class*='pricing'] li",
      "[class*='feature'] li",
      "[class*='include'] li",
      ".plan-features li",
      ".tier-features li",
      ".pricing-features li",
      ".feature-list li",
      ".plan-benefits li",
      "[class*='card'] ul li",
    ],
    limit: 60,
  },

  // Billing period options
  billing_options: {
    type: "list",
    selectors: [
      "[class*='billing'] button",
      "[class*='toggle'] button",
      "[class*='period'] button",
      "[class*='interval'] button",
      ".billing-toggle label",
      ".period-selector label",
      "input[name*='billing'] + label",
      "input[name*='period'] + label",
    ],
    limit: 4,
  },

  // CTA buttons per plan — tells you plan names + actions
  cta_buttons: {
    type: "list",
    selectors: [
      "[class*='plan'] a[href]",
      "[class*='tier'] a[href]",
      "[class*='pricing'] a[href*='signup']",
      "[class*='pricing'] a[href*='start']",
      "[class*='pricing'] button",
      ".plan-cta",
      ".pricing-cta",
    ],
    limit: 10,
  },

  // Contact sales indicator
  contact_sales: {
    type: "bool",
    selectors: [
      "[class*='enterprise'] a",
      "[class*='enterprise'] button",
      "a[href*='contact']",
      "a[href*='sales']",
      "button[class*='contact']",
    ],
    trueValues: ["contact sales", "talk to sales", "contact us", "get a demo", "request demo"],
  },
};

// ─── Review Page ──────────────────────────────────────────────────────────────

export const reviewRules: SchemaRules = {
  product_name: { type: "text", selectors: ["h1", '[itemprop="name"]'] },
  overall_rating: {
    type: "number",
    selectors: [
      '[itemprop="ratingValue"]', ".overall-rating",
      ".aggregate-rating", ".rating-score",
    ],
  },
  total_reviews: {
    type: "number",
    selectors: ['[itemprop="reviewCount"]', ".total-reviews", ".review-count"],
  },
  pros: {
    type: "list",
    selectors: [".pros li", ".advantages li", ".positives li"],
    limit: 10,
  },
  cons: {
    type: "list",
    selectors: [".cons li", ".disadvantages li", ".negatives li"],
    limit: 10,
  },
  summary: {
    type: "text",
    selectors: [".review-summary", ".verdict", ".conclusion p"],
  },
};

// ─── Schema Registry ──────────────────────────────────────────────────────────

export const SCHEMA_RULES: Record<string, SchemaRules> = {
  product: productRules,
  article: articleRules,
  job: jobRules,
  saas_ideas: saasIdeasRules,
  blog: blogRules,
  company: companyRules,
  pricing: pricingRules,
  review: reviewRules,
};

export const SCHEMA_DESCRIPTIONS: Record<string, string> = {
  product: "E-commerce product pages (name, price, stock, features)",
  article: "News articles (title, author, summary, key points)",
  job: "Job listings (title, skills, salary, responsibilities)",
  saas_ideas: "AI/SaaS business ideas from blogs and directories",
  blog: "Blog posts (tools mentioned, companies, code examples)",
  company: "Company profiles (funding, products, competitors)",
  pricing: "SaaS pricing pages (tiers, features, limits)",
  review: "Review pages (ratings, pros, cons, reviewer details)",
};
