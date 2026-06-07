/**
 * selectors.ts
 * CSS selector rule registry for every schema.
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
      '[itemprop="name"]', "h1",
    ],
  },
  price: {
    type: "number",
    selectors: [
      "p.price_color", ".price_color",
      ".woocommerce-Price-amount", "#priceblock_ourprice",
      "#priceblock_dealprice", ".price--main",
      '[itemprop="price"]', ".product-price", ".price",
    ],
  },
  original_price: {
    type: "number",
    selectors: [
      ".woocommerce-Price-amount del", ".price--compare",
      ".compare-at-price", "#listPrice", ".a-text-strike",
    ],
  },
  currency: {
    type: "text",
    selectors: [
      '[itemprop="priceCurrency"]',
      ".woocommerce-Price-currencySymbol",
    ],
  },
  in_stock: {
    type: "bool",
    selectors: [
      ".instock", ".instock.availability", ".stock",
      ".woocommerce-stock", "#availability",
      '[itemprop="availability"]', ".product-availability",
    ],
    trueValues: ["in stock", "instock", "available", "add to cart", "buy now"],
  },
  description: {
    type: "text",
    selectors: [
      "article.product_page > p", "#product-description > p",
      "#tab-description p",
      ".woocommerce-product-details__short-description",
      "#productDescription p", '[itemprop="description"]',
      ".product-description", ".product__description",
    ],
  },
  sku: {
    type: "text",
    selectors: ['[itemprop="sku"]', ".sku", ".product-sku", "#product_sku"],
  },
  brand: {
    type: "text",
    selectors: ['[itemprop="brand"]', ".brand", "#bylineInfo", ".product-meta__vendor"],
  },
  rating: {
    type: "rating",
    selectors: [
      "p.star-rating", ".star-rating",
      '[itemprop="ratingValue"]', ".a-icon-star span",
      ".woocommerce-product-rating .rating",
    ],
  },
  review_count: {
    type: "number",
    selectors: [
      '[itemprop="reviewCount"]', ".woocommerce-review-link",
      "#acrCustomerReviewText", ".review-count",
    ],
  },
  features: {
    type: "table",
    selectors: [
      "table.table", "table.product_attributes",
      "#productDetails_techSpec_section_1 tr",
      "#feature-bullets li", ".product-features li",
      ".woocommerce-product-attributes tr",
    ],
  },
  images: {
    type: "list",
    selectors: [
      ".woocommerce-product-gallery img", "#imgTagWrapperId img",
      ".product__media img", "[data-zoom-image]", ".product-image img",
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
      '[itemprop="author"]', ".author-name", ".byline",
      '[rel="author"]', ".post-author",
    ],
  },
  published_date: {
    type: "text",
    selectors: [
      '[itemprop="datePublished"]', "time[datetime]",
      ".post-date", ".entry-date", ".article-date",
    ],
  },
  summary: {
    type: "text",
    selectors: [
      ".post-excerpt", '[itemprop="description"]',
      "meta[name='description']", "article p:first-of-type",
    ],
  },
  content: {
    type: "text",
    selectors: [
      "article .entry-content", ".post-content",
      '[itemprop="articleBody"]', "article", "main",
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
};
content: {
  selectors: [
    "article .post-content",
    ".entry-content",
    "article p",
    ".post-body",
    "main article",
  ],
  extract: "text",
},
// ─── Job Listing ──────────────────────────────────────────────────────────────
export const jobRules: SchemaRules = {
  title: {
    type: "text",
    selectors: ["h1.posting-headline", ".job-title", '[itemprop="title"]', "h1"],
  },
  company: {
    type: "text",
    selectors: [".company-name", '[itemprop="hiringOrganization"]', ".employer"],
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

// ─── SaaS / AI Ideas — Ghost CMS + generic blogs ─────────────────────────────
export const saasIdeasRules: SchemaRules = {
  // Article title (single post) or site title (index)
  page_title: {
    type: "text",
    selectors: [
      "h1.gh-article-title",         // Ghost single post
      "h1.article-title",
      "h1",
      "title",
    ],
  },
  // Section headings inside an article = the actual ideas/topics
  ideas: {
    type: "list",
    selectors: [
      ".gh-content h2",              // Ghost article body
      ".gh-content h3",
      ".post-content h2",
      ".post-content h3",
      "article .content h2",
      "article .content h3",
      ".gh-card-title",              // Ghost blog index cards
      ".post-card-title",
      ".article-card h2",
      "article h2",
      "article h3",
      "main h2",
      "main h3",
    ],
    limit: 30,
  },
  // Article summary / excerpt
  summary: {
    type: "text",
    selectors: [
      ".gh-article-excerpt",         // Ghost
      ".post-card-excerpt",
      ".gh-content > p:first-of-type",
      ".post-content > p:first-of-type",
      "article p:first-of-type",
      "main p:first-of-type",
      "meta[name='description']",
    ],
  },
  // Tags / categories on the article
  categories: {
    type: "list",
    selectors: [
      ".gh-article-tag",             // Ghost single post tag
      ".post-card-tags",             // Ghost index card tags
      ".article-tag",
      ".post-tag",
      "a.tag",
      ".tags a",
      '[rel="tag"]',
      ".category a",
      ".label",
    ],
    limit: 10,
  },
  // Author name
  author: {
    type: "text",
    selectors: [
      ".gh-article-author-name",     // Ghost
      ".author-name",
      ".post-author-name",
      '[itemprop="author"]',
      '[rel="author"]',
      ".byline",
      ".author",
    ],
  },
  // Publish date
  published_date: {
    type: "text",
    selectors: [
      "time[datetime]",
      ".gh-article-meta time",
      ".post-date",
      ".entry-date",
      '[itemprop="datePublished"]',
    ],
  },
  // Code / tool names mentioned in article
  tools_mentioned: {
    type: "list",
    selectors: [
      ".gh-content code",            // Ghost inline code = tool names
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
export const pricingRules: SchemaRules = {
  product_name: { type: "text", selectors: ["h1", ".pricing-title"] },
  tiers: {
    type: "list",
    selectors: [".pricing-card h2", ".plan-name", ".tier-name", ".pricing-table th"],
    limit: 10,
  },
  prices: {
    type: "list",
    selectors: [".pricing-card .price", ".plan-price", ".amount", ".pricing-table td.price"],
    limit: 10,
  },
  features: {
    type: "list",
    selectors: [".pricing-card li", ".plan-features li", ".feature-list li"],
    limit: 30,
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
  product:    productRules,
  article:    articleRules,
  job:        jobRules,
  saas_ideas: saasIdeasRules,
  blog:       blogRules,
  company:    companyRules,
  pricing:    pricingRules,
  review:     reviewRules,
};

export const SCHEMA_DESCRIPTIONS: Record<string, string> = {
  product:    "E-commerce product pages (name, price, stock, features)",
  article:    "News articles (title, author, summary, key points)",
  job:        "Job listings (title, skills, salary, responsibilities)",
  saas_ideas: "AI/SaaS business ideas from blogs and directories",
  blog:       "Blog posts (tools mentioned, companies, code examples)",
  company:    "Company profiles (funding, products, competitors)",
  pricing:    "SaaS pricing pages (tiers, features, limits)",
  review:     "Review pages (ratings, pros, cons, reviewer details)",
};
