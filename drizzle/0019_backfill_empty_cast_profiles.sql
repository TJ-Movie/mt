UPDATE movies
SET cast_json = CASE title
  WHEN 'Avatar' THEN '[{"actor":"Sam Worthington","character":"Jake Sully","image":"/og.png"},{"actor":"Zoe Saldana","character":"Neytiri","image":"/og.png"},{"actor":"Sigourney Weaver","character":"Dr. Grace Augustine","image":"/og.png"}]'
  WHEN 'Avatar: The Way of Water' THEN '[{"actor":"Sam Worthington","character":"Jake Sully","image":"/og.png"},{"actor":"Zoe Saldana","character":"Neytiri","image":"/og.png"},{"actor":"Sigourney Weaver","character":"Kiri","image":"/og.png"}]'
  WHEN 'Joker' THEN '[{"actor":"Joaquin Phoenix","character":"Arthur Fleck","image":"/og.png"},{"actor":"Robert De Niro","character":"Murray Franklin","image":"/og.png"},{"actor":"Zazie Beetz","character":"Sophie Dumond","image":"/og.png"}]'
  ELSE cast_json END
WHERE publication_status = 'draft' AND trim(COALESCE(cast_json, '')) IN ('', '[]');
