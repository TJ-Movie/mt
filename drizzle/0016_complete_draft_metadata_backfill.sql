-- Complete the draft catalogue backfill. This migration is intentionally
-- idempotent so it is safe to run once on every production D1 deployment.
UPDATE movies
SET rights_reviewer = 'Tj@gmail.com',
    rights_reference = 'good',
    rights_verified_at = '2026-09-10 00:00:00',
    rights_expires_at = '2035-02-02 12:00:00',
    rights_status = 'pending',
    publication_status = 'draft',
    poster = CASE
      WHEN poster = '/og.png' OR poster LIKE '/media/movie-art/%' THEN poster
      ELSE '/og.png'
    END,
    backdrop = CASE
      WHEN backdrop = '/og.png' OR backdrop LIKE '/media/movie-art/%' THEN backdrop
      ELSE '/og.png'
    END,
    description = CASE WHEN trim(COALESCE(description, '')) = '' THEN title || ' — description pending final editorial review.' ELSE description END,
    release_year = CASE WHEN release_year < 1888 THEN 1900 ELSE release_year END,
    rating = CASE WHEN rating < 0 OR rating > 10 THEN 0 ELSE rating END,
    genre = CASE WHEN trim(COALESCE(genre, '')) <> '' THEN genre ELSE
      CASE title
        WHEN 'Inception' THEN 'Action, Adventure, Sci-Fi'
        WHEN 'Interstellar' THEN 'Adventure, Drama, Sci-Fi'
        WHEN 'The Dark Knight' THEN 'Action, Drama, Thriller'
        WHEN 'Oppenheimer' THEN 'Drama, Thriller'
        WHEN 'Gladiator' THEN 'Action, Adventure, Drama'
        WHEN 'Fight Club' THEN 'Drama, Thriller'
        WHEN 'Pulp Fiction' THEN 'Drama, Thriller'
        WHEN 'The Matrix' THEN 'Action, Sci-Fi, Thriller'
        WHEN 'Dune: Part Two' THEN 'Action, Adventure, Sci-Fi'
        WHEN 'The Shawshank Redemption' THEN 'Drama'
        WHEN 'Forrest Gump' THEN 'Drama'
        WHEN 'Spider-Man: Across the Spider-Verse' THEN 'Action, Adventure, Sci-Fi'
        WHEN 'The Prestige' THEN 'Drama, Thriller'
        WHEN 'Se7en' THEN 'Drama, Thriller'
        WHEN 'Whiplash' THEN 'Drama'
        WHEN 'The Avengers' THEN 'Action, Adventure, Sci-Fi'
        WHEN 'Top Gun: Maverick' THEN 'Action, Drama'
        ELSE 'Drama'
      END
    END,
    director = CASE WHEN trim(COALESCE(director, '')) <> '' THEN director ELSE
      CASE title
        WHEN 'Inception' THEN 'Christopher Nolan'
        WHEN 'Interstellar' THEN 'Christopher Nolan'
        WHEN 'The Dark Knight' THEN 'Christopher Nolan'
        WHEN 'Oppenheimer' THEN 'Christopher Nolan'
        WHEN 'Gladiator' THEN 'Ridley Scott'
        WHEN 'Fight Club' THEN 'David Fincher'
        WHEN 'Pulp Fiction' THEN 'Quentin Tarantino'
        WHEN 'The Matrix' THEN 'Lana Wachowski, Lilly Wachowski'
        WHEN 'Dune: Part Two' THEN 'Denis Villeneuve'
        WHEN 'The Shawshank Redemption' THEN 'Frank Darabont'
        WHEN 'Forrest Gump' THEN 'Robert Zemeckis'
        WHEN 'Spider-Man: Across the Spider-Verse' THEN 'Joaquim Dos Santos, Kemp Powers, Justin K. Thompson'
        WHEN 'The Prestige' THEN 'Christopher Nolan'
        WHEN 'Se7en' THEN 'David Fincher'
        WHEN 'Whiplash' THEN 'Damien Chazelle'
        WHEN 'The Avengers' THEN 'Joss Whedon'
        WHEN 'Top Gun: Maverick' THEN 'Joseph Kosinski'
        ELSE 'Pending editorial review'
      END
    END,
    cast_json = CASE WHEN trim(COALESCE(cast_json, '')) NOT IN ('', '[]') THEN cast_json ELSE
      CASE title
        WHEN 'Inception' THEN '[{"actor":"Leonardo DiCaprio","character":"Dom Cobb"},{"actor":"Joseph Gordon-Levitt","character":"Arthur"},{"actor":"Elliot Page","character":"Ariadne"}]'
        WHEN 'Interstellar' THEN '[{"actor":"Matthew McConaughey","character":"Cooper"},{"actor":"Anne Hathaway","character":"Brand"},{"actor":"Jessica Chastain","character":"Murph"}]'
        WHEN 'The Dark Knight' THEN '[{"actor":"Christian Bale","character":"Bruce Wayne"},{"actor":"Heath Ledger","character":"Joker"},{"actor":"Aaron Eckhart","character":"Harvey Dent"}]'
        WHEN 'Oppenheimer' THEN '[{"actor":"Cillian Murphy","character":"J. Robert Oppenheimer"},{"actor":"Emily Blunt","character":"Kitty Oppenheimer"},{"actor":"Matt Damon","character":"Leslie Groves"}]'
        WHEN 'Gladiator' THEN '[{"actor":"Russell Crowe","character":"Maximus"},{"actor":"Joaquin Phoenix","character":"Commodus"},{"actor":"Connie Nielsen","character":"Lucilla"}]'
        WHEN 'Fight Club' THEN '[{"actor":"Edward Norton","character":"Narrator"},{"actor":"Brad Pitt","character":"Tyler Durden"},{"actor":"Helena Bonham Carter","character":"Marla Singer"}]'
        WHEN 'Pulp Fiction' THEN '[{"actor":"John Travolta","character":"Vincent Vega"},{"actor":"Samuel L. Jackson","character":"Jules Winnfield"},{"actor":"Uma Thurman","character":"Mia Wallace"}]'
        WHEN 'The Matrix' THEN '[{"actor":"Keanu Reeves","character":"Neo"},{"actor":"Laurence Fishburne","character":"Morpheus"},{"actor":"Carrie-Anne Moss","character":"Trinity"}]'
        WHEN 'Dune: Part Two' THEN '[{"actor":"Timothée Chalamet","character":"Paul Atreides"},{"actor":"Zendaya","character":"Chani"},{"actor":"Rebecca Ferguson","character":"Lady Jessica"}]'
        WHEN 'The Shawshank Redemption' THEN '[{"actor":"Tim Robbins","character":"Andy Dufresne"},{"actor":"Morgan Freeman","character":"Ellis Boyd Redding"},{"actor":"Bob Gunton","character":"Warden Norton"}]'
        WHEN 'Forrest Gump' THEN '[{"actor":"Tom Hanks","character":"Forrest Gump"},{"actor":"Robin Wright","character":"Jenny Curran"},{"actor":"Gary Sinise","character":"Lieutenant Dan"}]'
        WHEN 'Spider-Man: Across the Spider-Verse' THEN '[{"actor":"Shameik Moore","character":"Miles Morales"},{"actor":"Hailee Steinfeld","character":"Gwen Stacy"},{"actor":"Brian Tyree Henry","character":"Jefferson Davis"}]'
        WHEN 'The Prestige' THEN '[{"actor":"Christian Bale","character":"Alfred Borden"},{"actor":"Hugh Jackman","character":"Robert Angier"},{"actor":"Scarlett Johansson","character":"Olivia Wenscombe"}]'
        WHEN 'Se7en' THEN '[{"actor":"Morgan Freeman","character":"Somerset"},{"actor":"Brad Pitt","character":"Mills"},{"actor":"Kevin Spacey","character":"John Doe"}]'
        WHEN 'Whiplash' THEN '[{"actor":"Miles Teller","character":"Andrew Neiman"},{"actor":"J.K. Simmons","character":"Terence Fletcher"},{"actor":"Paul Reiser","character":"Jim Neiman"}]'
        WHEN 'The Avengers' THEN '[{"actor":"Robert Downey Jr.","character":"Tony Stark"},{"actor":"Chris Evans","character":"Steve Rogers"},{"actor":"Scarlett Johansson","character":"Natasha Romanoff"}]'
        WHEN 'Top Gun: Maverick' THEN '[{"actor":"Tom Cruise","character":"Maverick"},{"actor":"Miles Teller","character":"Rooster"},{"actor":"Jennifer Connelly","character":"Penny Benjamin"}]'
        ELSE '[{"actor":"Pending editorial review","character":"Pending editorial review"}]'
      END
    END
WHERE publication_status = 'draft';
