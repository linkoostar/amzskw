-- reviews module v3: product details cache (title/image/price/brand per ASIN).
-- Source: Apify junglee/amazon-reviews-scraper with scrapeProductDetails=true.
-- The actor adds one extra product-page fetch per run (a few seconds); billing is
-- still per delivered review row, so this is essentially free metadata.
-- ADD-ONLY migration: creates a new table only; old code ignores it.

CREATE TABLE IF NOT EXISTS review_products (
  asin TEXT NOT NULL,
  country_code TEXT NOT NULL DEFAULT 'US',
  title TEXT,                 -- product title from the Amazon product page
  image TEXT,                 -- main image URL
  price REAL,                 -- listed price (numeric part)
  currency TEXT,              -- e.g. USD if the actor reports it
  brand TEXT,
  url TEXT,                   -- canonical product URL
  stars REAL,                 -- product page overall star rating (all ratings)
  ratings_count INTEGER,      -- product page total ratings count
  reviews_count INTEGER,      -- product page total reviews count
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(asin, country_code)
);
CREATE INDEX IF NOT EXISTS idx_review_products_asin ON review_products(asin, country_code);
