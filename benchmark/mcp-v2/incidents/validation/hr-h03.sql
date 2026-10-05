-- anomaly: employee 83 sits at /1/1/8/, under the Engineering Manager (/1/1/, employee 3)
SELECT (SELECT organizationnode FROM humanresources.employee WHERE businessentityid = 83) = '/1/1/8/'
  AND (SELECT businessentityid FROM humanresources.employee WHERE organizationnode = '/1/1/') = 3 AS ok;
-- check: employee 83 is still a WC40 production technician in Production; WC40 supervisors are 78, 127, 192
SELECT (SELECT jobtitle FROM humanresources.employee WHERE businessentityid = 83) = 'Production Technician - WC40'
  AND (SELECT array_agg(departmentid) FROM humanresources.employeedepartmenthistory WHERE businessentityid = 83 AND enddate IS NULL) = ARRAY[7]::smallint[]
  AND (SELECT array_agg(businessentityid ORDER BY businessentityid) FROM humanresources.employee WHERE jobtitle = 'Production Supervisor - WC40') = ARRAY[78, 127, 192] AS ok;
-- unique: every other non-root node has a parent, and every other production technician reports to a production supervisor
SELECT NOT EXISTS (SELECT 1 FROM humanresources.employee e WHERE e.organizationnode <> '/' AND NOT EXISTS
    (SELECT 1 FROM humanresources.employee m WHERE m.organizationnode = regexp_replace(e.organizationnode, '[^/]+/$', '')))
  AND NOT EXISTS (SELECT 1 FROM humanresources.employee e JOIN humanresources.employee m ON m.organizationnode = regexp_replace(e.organizationnode, '[^/]+/$', '')
    WHERE e.jobtitle LIKE 'Production Technician%' AND e.businessentityid <> 83 AND m.jobtitle NOT LIKE 'Production Supervisor%') AS ok;
