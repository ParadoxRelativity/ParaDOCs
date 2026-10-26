-- A presentation's access was capped by the role's Docs permissions (0053 reused
-- document_access_level), so slides.* never counted. Cap it by Slides instead, as
-- spreadsheet_access_level caps by Sheets.
CREATE OR REPLACE FUNCTION presentation_access_level(p_user uuid, p_role uuid, p_access text, p_presentation uuid, p_folder uuid)
RETURNS smallint LANGUAGE sql STABLE AS $$
  SELECT capped_level(role_ceiling(p_role, 'slides'), filed_list_level(p_user, p_access, p_presentation, p_folder))
$$;
