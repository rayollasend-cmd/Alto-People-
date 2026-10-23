-- What's new, by audience (F500 G5).
--
-- The two notes the web bundle used to carry (20261018090000_release_notes)
-- tagged three worker-only lines "ALL", so a client's store manager read
-- "Confirm a shift with one tap" and "Your clock-in number now lives on your
-- Home screen". They are the associate's: re-tag those three lines
-- ASSOCIATE. Matched by their exact English text; a note anyone has since
-- rewritten is left alone. Data only — no column changes.

UPDATE "ReleaseNote" n
SET "items" = (
  SELECT jsonb_agg(
           CASE
             WHEN i->>'audience' = 'ALL' AND i->>'en' IN (
               'Confirm a shift with one tap, right from the schedule list.',
               'Your clock-in number now lives on your Home screen — tap to reveal.',
               'You''ll get “Your week ahead” the evening before your work week starts.'
             )
             THEN jsonb_set(i, '{audience}', '"ASSOCIATE"')
             ELSE i
           END
           ORDER BY ord
         )
  FROM jsonb_array_elements(n."items") WITH ORDINALITY AS t(i, ord)
)
WHERE n."day" IN ('2026-09-03', '2026-07-02')
  AND jsonb_typeof(n."items") = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(n."items") i
    WHERE i->>'audience' = 'ALL' AND i->>'en' IN (
      'Confirm a shift with one tap, right from the schedule list.',
      'Your clock-in number now lives on your Home screen — tap to reveal.',
      'You''ll get “Your week ahead” the evening before your work week starts.'
    )
  );
