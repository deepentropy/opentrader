-- A post can carry its author's chart: the chart state ("Open on my chart":
-- symbol, interval, drawings, as JSON) and a picture (in the IMAGES bucket,
-- key charts/<post id>).
ALTER TABLE posts ADD COLUMN chart TEXT;
ALTER TABLE posts ADD COLUMN has_image INTEGER NOT NULL DEFAULT 0;
