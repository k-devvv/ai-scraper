/**
 * selectors.ts
 * CSS selector rule sets for Cheerio-based extraction.
 */

export interface SelectorField {
  selectors: string[];
  extract?: "text" | "href" | "src" | "attr" | "html" | "number" | "boolean";
  attr?: string;
  multiple?: boolean;
  transform?: (val: string) => unknown;
}

export type SelectorSchema = Record<string, SelectorField>;

// ─── Product ──────────────────────────────────────────────────────────────────

export const productSelectors: SelectorSchema = {
  product_name: {
    selectors: [
      "h1.product_title", "h1[itemprop='name']", ".product-title h1",
      ".pdp-title", "#productTitle", "h1.title", "h1",
    ],
    extract: "text",
  },
  price: {
    selectors: [
      ".price ins .amount", ".woocommerce-Price-amount", "span[itemprop='price']",
      ".price-tag", "#priceblock_ourprice", ".a-price-whole", "[data-price]",
      "p.price_color", ".price_color", ".product-price", "[class*='price']", ".price",
    ],
    extract: "text",
    transform: (v) => parseFloat(v.replace(/[^0-9.]/g, "")) || null,
  },
  original_price: {
    selectors: [".price del .amount", ".original-price", ".price__compare", "s.price"],
    extract: "text",
    transform: (v) => parseFloat(v.replace(/[^0-9.]/g, "")) || null,
  },
  in_stock: {
    selectors: [
      ".instock", ".instock.availability", ".stock", ".availability",
      "[itemprop='availability']", ".product-availability", "#availability",
    ],
    extract: "text",
    transform: (v) => !/(out of stock|unavailable|sold out)/i.test(v),
  },
  rating: {
    selectors: [
      "[itemprop='ratingValue']", ".average-rating", ".product-rating",
      ".star-rating", "[class*='star-rating']",
    ],
    extract: "attr",
    attr: "class",
    transform: (v) => {
      const wordMap: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
      const match = v.toLowerCase().match(/\b(one|two|three|four|five)\b/);
      if (match) return wordMap[match[1]];
      const num = parseFloat(v);
      return isNaN(num) ? null : num;
    },
  },
  review_count: {
    selectors: [
      ".woocommerce-review-link", "[itemprop='reviewCount']",
      ".review-count", "#acrCustomerReviewText",
    ],
    extract: "text",
    transform: (v) => parseInt(v.replace(/[^0-9]/g, ""), 10) || null,
  },
  description: {
    selectors: [
      ".woocommerce-product-details__short-description", "[itemprop='description']",
      ".product-description", "#productDescription", "article.product_page > p",
      ".product_main ~ p", ".description p", ".description",
    ],
    extract: "text",
  },
  sku: {
    selectors: ["[itemprop='sku']", ".sku", ".product-sku", "#product-sku"],
    extract: "text",
  },
  brand: {
    selectors: ["[itemprop='brand']", ".brand", ".product-brand", "#bylineInfo"],
    extract: "text",
  },
  images: {
    selectors: [
      ".woocommerce-product-gallery img", ".product-images img",
      "[itemprop='image']", ".product-image img",
    ],
    extract: "src",
    multiple: true,
  },
  features: {
    selectors: [
      ".woocommerce-product-details__short-description li", "#feature-bullets li",
      ".product-features li", ".product-description li",
      "table.table tr", ".product_main ul li",
    ],
    extract: "text",
    multiple: true,
  },
};

// ─── Article / Blog ───────────────────────────────────────────────────────────

export const articleSelectors: SelectorSchema = {
  title: {
    selectors: [
      "h1.entry-title", "h1.post-title", "article h1",
      "[itemprop='headline']", "h1",
    ],
    extract: "text",
  },
  author: {
    selectors: [
      "a[href*='/author/']",
      ".author-name",
      "[data-testid='author-name']",
      ".byline a",
      "[itemprop='author']",
      "[rel='author']",
      ".post-author",
      ".entry-author",
      "span.author",
      ".byline",
    ],
    extract: "text",
    multiple: true,
  },
  published_date: {
    selectors: [
      "time",
      "time[datetime]",
      ".post-date",
      "[data-testid='publish-date']",
      "[itemprop='datePublished']",
      ".entry-date",
      ".published",
    ],
    extract: "text",
  },
  summary: {
    selectors: [
      "[itemprop='description']",
      "meta[name='description']",
      ".post-excerpt",
      ".entry-summary",
    ],
    extract: "attr",
    attr: "content",
  },
  tags: {
    selectors: [
      ".post-tags a", ".article-tags a", ".entry-tags a",
      ".tags a", "[rel='tag']", ".tag-list a",
    ],
    extract: "text",
    multiple: true,
  },
  key_points: {
    selectors: [
      "article h2", "article h3",
      ".entry-content h2", ".post-content h2",
    ],
    extract: "text",
    multiple: true,
  },
};

// ─── Job Listing ──────────────────────────────────────────────────────────────

export const jobSelectors: SelectorSchema = {
  title: {
    selectors: [
      "h1.job-title", "[itemprop='title']", ".posting-headline h2",
      ".job-header h1", "h1",
    ],
    extract: "text",
  },
  company: {
    selectors: [
      "[itemprop='hiringOrganization']", ".company-name",
      ".employer-name", ".posting-categories .sort-by-team",
    ],
    extract: "text",
  },
  location: {
    selectors: [
      "[itemprop='jobLocation']", ".location", ".job-location",
      ".posting-categories .sort-by-location",
    ],
    extract: "text",
  },
  remote: {
    selectors: [".location", ".remote-label", ".work-type"],
    extract: "text",
    transform: (v) => /remote/i.test(v),
  },
  employment_type: {
    selectors: [
      "[itemprop='employmentType']", ".employment-type",
      ".job-type", ".posting-categories .sort-by-commitment",
    ],
    extract: "text",
  },
  salary_min: {
    selectors: ["[itemprop='baseSalary']", ".salary-range", ".compensation"],
    extract: "text",
    transform: (v) => {
      const m = v.match(/[\$£€]?\s*([\d,]+)/);
      return m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
    },
  },
  required_skills: {
    selectors: [
      ".requirements li", ".qualifications li",
      ".skills li", ".job-requirements li",
    ],
    extract: "text",
    multiple: true,
  },
  responsibilities: {
    selectors: [
      ".responsibilities li", ".role-description li", ".job-description li",
    ],
    extract: "text",
    multiple: true,
  },
  posted_date: {
    selectors: [
      "[itemprop='datePosted']", "time[datetime]",
      ".posted-date", ".posting-date",
    ],
    extract: "attr",
    attr: "datetime",
  },
};

// ─── Pricing ──────────────────────────────────────────────────────────────────

export const pricingSelectors: SelectorSchema = {
  company_name: {
    selectors: ["meta[property='og:site_name']", "header .logo", ".brand"],
    extract: "attr",
    attr: "content",
  },
};

// ─── Review ───────────────────────────────────────────────────────────────────

export const reviewSelectors: SelectorSchema = {
  overall_rating: {
    selectors: [
      "[itemprop='ratingValue']", ".overall-rating",
      ".average-rating", ".star-rating",
    ],
    extract: "text",
    transform: (v) => parseFloat(v) || null,
  },
  total_reviews: {
    selectors: [
      "[itemprop='reviewCount']", ".total-reviews", ".review-count",
    ],
    extract: "text",
    transform: (v) => parseInt(v.replace(/[^0-9]/g, ""), 10) || null,
  },
};

// ─── SaaS Ideas ───────────────────────────────────────────────────────────────

export const saasIdeasSelectors: SelectorSchema = {
  page_topic: {
    selectors: ["h1", "title", "meta[property='og:title']"],
    extract: "text",
  },
  source_type: {
    selectors: ["meta[property='og:type']", ".post-type", ".content-type"],
    extract: "attr",
    attr: "content",
  },
};

// ─── Generic / Fallback ───────────────────────────────────────────────────────

export const genericSelectors: SelectorSchema = {
  title: {
    selectors: ["h1", "title", "meta[property='og:title']"],
    extract: "text",
  },
  description: {
    selectors: [
      "meta[name='description']", "meta[property='og:description']",
    ],
    extract: "attr",
    attr: "content",
  },
  main_content: {
    selectors: ["main", "article", ".content", "#content", "body"],
    extract: "text",
  },
};

// ─── Registry ─────────────────────────────────────────────────────────────────

export const SELECTOR_MAP: Record<string, SelectorSchema> = {
  product: productSelectors,
  article: articleSelectors,
  job: jobSelectors,
  pricing: pricingSelectors,
  review: reviewSelectors,
  saas_ideas: saasIdeasSelectors,
  blog: articleSelectors,
  company: genericSelectors,
  generic: genericSelectors,
};