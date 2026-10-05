-- anomaly: employee 30 has two open department assignments
SELECT (SELECT count(*) FROM humanresources.employeedepartmenthistory WHERE businessentityid = 30 AND enddate IS NULL) = 2 AS ok;
-- check: the open assignments are Production (since 2009-01-29) and Quality Assurance (since 2025-03-03)
SELECT (SELECT array_agg(departmentid || '@' || startdate ORDER BY startdate) FROM humanresources.employeedepartmenthistory
  WHERE businessentityid = 30 AND enddate IS NULL) = ARRAY['7@2009-01-29', '13@2025-03-03'] AS ok;
-- unique: every other employee has exactly one open assignment
SELECT NOT EXISTS (SELECT 1 FROM humanresources.employee e WHERE e.businessentityid <> 30 AND
  (SELECT count(*) FROM humanresources.employeedepartmenthistory h WHERE h.businessentityid = e.businessentityid AND h.enddate IS NULL) <> 1) AS ok;
