/**
 * schemas.ts
 * Reusable extraction schema definitions for Ollama local extraction.
 *
 * Schemas: product, article, job, saas_ideas, blog, company, pricing, review
 */

import type { OllamaSchema } from "./extractor";

// ─── Product / E-Commerce ────────────────────────────────────────────────────

export interface ProductData {
  product_name: string;
  brand: string | null;
  price: number | null;
  currency: string | null;
  original_price: number | null;
  discount_percent: number | null;
  in_stock: boolean;
  rating: number | null;
  review_count: number | null;
  features: string[];
  images: string[];
  description: string | null;
  sku: string | null;
}

export const productSchema: OllamaSchema = {
  name: "extract_product",
  description: "Extract complete product information from an e-commerce product page.",
  input_schema: {
    type: "object",
    properties: {
      product_name: { type: "string" },
      brand: { type: "string" },
      price: { type: "number" },
      currency: { type: "string" },
      original_price: { type: "number" },
      discount_percent: { type: "number" },
      in_stock: { type: "boolean" },
      rating: { type: "number" },
      review_count: { type: "number" },
      features: { type: "array", items: { type: "string" } },
      images: { type: "array", items: { type: "string" } },
      description: { type: "string" },
      sku: { type: "string" },
    },
    required: ["product_name", "in_stock", "features"],
  },
};

// ─── Article / Blog Post ─────────────────────────────────────────────────────

export interface ArticleData {
  title: string;
  author: string | null;
  published_date: string | null;
  summary: string;
  key_points: string[];
  tags: string[];
  word_count: number | null;
}

export const articleSchema: OllamaSchema = {
  name: "extract_article",
  description: "Extract structured information from a news article or blog post.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      author: { type: "string" },
      published_date: { type: "string" },
      summary: { type: "string" },
      key_points: { type: "array", items: { type: "string" } },
      tags: { type: "array", items: { type: "string" } },
      word_count: { type: "number" },
    },
    required: ["title", "summary", "key_points"],
  },
};

// ─── Job Listing ─────────────────────────────────────────────────────────────

export interface JobData {
  title: string;
  company: string | null;
  location: string | null;
  remote: boolean;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  employment_type: string | null;
  experience_years: number | null;
  required_skills: string[];
  responsibilities: string[];
  posted_date: string | null;
  apply_url: string | null;
}

export const jobSchema: OllamaSchema = {
  name: "extract_job",
  description: "Extract structured information from a job listing page.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      company: { type: "string" },
      location: { type: "string" },
      remote: { type: "boolean" },
      salary_min: { type: "number" },
      salary_max: { type: "number" },
      salary_currency: { type: "string" },
      employment_type: { type: "string" },
      experience_years: { type: "number" },
      required_skills: { type: "array", items: { type: "string" } },
      responsibilities: { type: "array", items: { type: "string" } },
      posted_date: { type: "string" },
      apply_url: { type: "string" },
    },
    required: ["title", "required_skills", "responsibilities"],
  },
};

// ─── SaaS / AI Agent Ideas ───────────────────────────────────────────────────

export interface SaasIdeaItem {
  idea_name: string;
  target_industry: string;
  problem_solved: string;
  how_it_works: string;
  monetization: string;
  tech_stack: string[];
  difficulty: string;
  market_size: string | null;
}

export interface SaasIdeasData {
  ideas: SaasIdeaItem[];
  source_type: string | null;
  page_topic: string | null;
}

export const saasIdeasSchema: OllamaSchema = {
  name: "extract_saas_ideas",
  description:
    "Extract all SaaS, AI agent, and automation business ideas from the page. Each idea should have a name, target industry, problem it solves, how it works, monetization model, tech stack, and difficulty level.",
  input_schema: {
    type: "object",
    properties: {
      ideas: {
        type: "array",
        items: {
          type: "object",
          properties: {
            idea_name: {
              type: "string",
              description: "Name or title of the automation or SaaS idea",
            },
            target_industry: {
              type: "string",
              description: "Industry or persona this is built for e.g. Finance, HR, E-commerce",
            },
            problem_solved: {
              type: "string",
              description: "The manual pain point, cost, or inefficiency this eliminates",
            },
            how_it_works: {
              type: "string",
              description: "How the AI agent or automation executes the task step by step",
            },
            monetization: {
              type: "string",
              description: "How this could be sold e.g. per-seat SaaS, usage-based, one-time setup fee",
            },
            tech_stack: {
              type: "array",
              items: { type: "string" },
              description: "Technologies mentioned or implied e.g. LangChain, n8n, OpenAI, Zapier",
            },
            difficulty: {
              type: "string",
              description: "Estimated build difficulty: easy, medium, or hard",
            },
            market_size: {
              type: "string",
              description: "Any market size or TAM figures mentioned",
            },
          },
          required: ["idea_name", "target_industry", "problem_solved", "how_it_works"],
        },
      },
      source_type: {
        type: "string",
        description: "Type of source page e.g. blog post, case study, product directory, forum",
      },
      page_topic: {
        type: "string",
        description: "Main topic of the page in one sentence",
      },
    },
    required: ["ideas"],
  },
};

// ─── Blog / Content Page ─────────────────────────────────────────────────────

export interface BlogData {
  title: string;
  author: string | null;
  published_date: string | null;
  category: string | null;
  summary: string;
  key_points: string[];
  tools_mentioned: string[];
  companies_mentioned: string[];
  tags: string[];
  reading_time_mins: number | null;
  has_code_examples: boolean;
}

export const blogSchema: OllamaSchema = {
  name: "extract_blog",
  description:
    "Extract full structured information from a blog post including tools, companies, key insights, and code presence.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      author: { type: "string" },
      published_date: { type: "string" },
      category: { type: "string" },
      summary: { type: "string" },
      key_points: { type: "array", items: { type: "string" } },
      tools_mentioned: { type: "array", items: { type: "string" } },
      companies_mentioned: { type: "array", items: { type: "string" } },
      tags: { type: "array", items: { type: "string" } },
      reading_time_mins: { type: "number" },
      has_code_examples: { type: "boolean" },
    },
    required: ["title", "summary", "key_points"],
  },
};

// ─── Company / Startup Profile ────────────────────────────────────────────────

export interface CompanyData {
  name: string;
  tagline: string | null;
  description: string | null;
  founded_year: number | null;
  headquarters: string | null;
  employee_count: string | null;
  funding_stage: string | null;
  total_funding: string | null;
  industry: string[];
  products: string[];
  customers: string[];
  competitors: string[];
  website: string | null;
  social_links: Record<string, string>;
}

export const companySchema: OllamaSchema = {
  name: "extract_company",
  description:
    "Extract company profile information including funding, products, customers, and competitors.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      tagline: { type: "string" },
      description: { type: "string" },
      founded_year: { type: "number" },
      headquarters: { type: "string" },
      employee_count: { type: "string" },
      funding_stage: { type: "string" },
      total_funding: { type: "string" },
      industry: { type: "array", items: { type: "string" } },
      products: { type: "array", items: { type: "string" } },
      customers: { type: "array", items: { type: "string" } },
      competitors: { type: "array", items: { type: "string" } },
      website: { type: "string" },
      social_links: {
        type: "object",
        additionalProperties: { type: "string" },
      },
    },
    required: ["name"],
  },
};

// ─── Pricing Page ─────────────────────────────────────────────────────────────

export interface PricingTier {
  tier_name: string;
  price_monthly: number | null;
  price_annual: number | null;
  currency: string | null;
  target_user: string | null;
  features: string[];
  limits: Record<string, string>;
  is_popular: boolean;
  has_free_trial: boolean;
}

export interface PricingData {
  company_name: string | null;
  product_name: string | null;
  tiers: PricingTier[];
  has_free_plan: boolean;
  billing_options: string[];
  enterprise_available: boolean;
  contact_sales_required: boolean;
}

export const pricingSchema: OllamaSchema = {
  name: "extract_pricing",
  description:
    "Extract all pricing tiers, features, limits, and billing options from a SaaS pricing page.",
  input_schema: {
    type: "object",
    properties: {
      company_name: { type: "string" },
      product_name: { type: "string" },
      tiers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tier_name: { type: "string" },
            price_monthly: { type: "number" },
            price_annual: { type: "number" },
            currency: { type: "string" },
            target_user: { type: "string" },
            features: { type: "array", items: { type: "string" } },
            limits: { type: "object", additionalProperties: { type: "string" } },
            is_popular: { type: "boolean" },
            has_free_trial: { type: "boolean" },
          },
          required: ["tier_name", "features"],
        },
      },
      has_free_plan: { type: "boolean" },
      billing_options: { type: "array", items: { type: "string" } },
      enterprise_available: { type: "boolean" },
      contact_sales_required: { type: "boolean" },
    },
    required: ["tiers"],
  },
};

// ─── Review / Testimonial Page ────────────────────────────────────────────────

export interface ReviewItem {
  reviewer_name: string | null;
  reviewer_role: string | null;
  reviewer_company: string | null;
  rating: number | null;
  review_text: string;
  date: string | null;
  verified: boolean;
  helpful_count: number | null;
  pros: string[];
  cons: string[];
}

export interface ReviewData {
  product_name: string | null;
  overall_rating: number | null;
  total_reviews: number | null;
  rating_breakdown: Record<string, number>;
  reviews: ReviewItem[];
}

export const reviewSchema: OllamaSchema = {
  name: "extract_reviews",
  description:
    "Extract all reviews, ratings, pros, cons, and reviewer details from a review or testimonial page.",
  input_schema: {
    type: "object",
    properties: {
      product_name: { type: "string" },
      overall_rating: { type: "number" },
      total_reviews: { type: "number" },
      rating_breakdown: {
        type: "object",
        additionalProperties: { type: "number" },
      },
      reviews: {
        type: "array",
        items: {
          type: "object",
          properties: {
            reviewer_name: { type: "string" },
            reviewer_role: { type: "string" },
            reviewer_company: { type: "string" },
            rating: { type: "number" },
            review_text: { type: "string" },
            date: { type: "string" },
            verified: { type: "boolean" },
            helpful_count: { type: "number" },
            pros: { type: "array", items: { type: "string" } },
            cons: { type: "array", items: { type: "string" } },
          },
          required: ["review_text"],
        },
      },
    },
    required: ["reviews"],
  },
};

// ─── Schema Registry ──────────────────────────────────────────────────────────

export const SCHEMA_MAP = {
  product: productSchema,
  article: articleSchema,
  job: jobSchema,
  saas_ideas: saasIdeasSchema,
  blog: blogSchema,
  company: companySchema,
  pricing: pricingSchema,
  review: reviewSchema,
} as const;

export type SchemaKey = keyof typeof SCHEMA_MAP;
