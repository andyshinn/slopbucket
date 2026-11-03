-- 0013: the spoken language of each post (ISO 639-1 code, `und` when it can't be
-- told), detected without a model from the title and the extracted text, for the
-- review queue's language filter. NULL means not detected yet: the `languages`
-- job on the fetch queue fills those from the text cached in R2.
ALTER TABLE posts ADD COLUMN language TEXT;
