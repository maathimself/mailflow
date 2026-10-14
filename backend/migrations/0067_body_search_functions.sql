-- A character cap does not bound the packed vector size. Cutting through a
-- repeated word can even make the capped vector larger than the complete one.
-- Return NULL for that size error so expression indexes cannot break writes.
CREATE FUNCTION mailflow_body_search_vector(body text) RETURNS tsvector
LANGUAGE plpgsql IMMUTABLE PARALLEL UNSAFE AS $$
BEGIN
  RETURN to_tsvector('english', LEFT(coalesce(body,''), 600000));
EXCEPTION WHEN program_limit_exceeded THEN
  IF SQLSTATE <> '54000' THEN RAISE; END IF;
  RETURN NULL;
END
$$;

-- Stock English normalizes individual tokens; plainto_tsquery joins surviving
-- lexemes with AND. Test containment without constructing an oversized vector.
-- ts_debug needs the vector builder's token/lexeme byte limits applied here.
CREATE FUNCTION mailflow_body_overflow_matches(body text, term text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN cardinality(query_lexemes) = 0 THEN false ELSE
    query_lexemes <@ ARRAY(
      SELECT lexeme
      FROM ts_debug('english', LEFT(coalesce(body,''), 600000))
      CROSS JOIN LATERAL unnest(lexemes) AS lexeme
      WHERE octet_length(token) < 2047 AND octet_length(lexeme) <= 2047
    ) END
  FROM (SELECT tsvector_to_array(to_tsvector('english', coalesce(term,''))) AS query_lexemes) q;
$$;
