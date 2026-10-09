-- anomaly: employee 252 left Purchasing for Marketing on 2025-07-15
SELECT (SELECT array_agg(departmentid || '@' || startdate || '-' || coalesce(enddate::text, 'open') ORDER BY startdate) FROM humanresources.employeedepartmenthistory WHERE businessentityid = 252)
  = ARRAY['5@2009-02-28-2025-07-14', '4@2025-07-15-open'] AS ok;
-- check: exactly 13 purchase orders dated 2025-07-15 or later list employee 252
SELECT (SELECT count(*) FROM purchasing.purchaseorderheader WHERE employeeid = 252 AND orderdate >= '2025-07-15') = 13 AS ok;
-- unique: every other purchase order was placed by someone in Purchasing on its order date
SELECT NOT EXISTS (SELECT 1 FROM purchasing.purchaseorderheader h WHERE NOT (h.employeeid = 252 AND h.orderdate >= '2025-07-15')
  AND NOT EXISTS (SELECT 1 FROM humanresources.employeedepartmenthistory e WHERE e.businessentityid = h.employeeid AND e.departmentid = 5
    AND h.orderdate::date >= e.startdate AND (e.enddate IS NULL OR h.orderdate::date <= e.enddate))) AS ok;
