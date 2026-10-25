UPDATE profiles
SET city = location
WHERE city IS NULL
  AND location IS NOT NULL
  AND trim(location) <> '';
