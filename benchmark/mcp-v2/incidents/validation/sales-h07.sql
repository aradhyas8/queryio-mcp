-- anomaly: salesperson 276 is reassigned to Canada from 2025-02-01
SELECT (SELECT array_agg(territoryid || '@' || startdate::date || '-' || coalesce(enddate::date::text, 'open') ORDER BY startdate) FROM sales.salesterritoryhistory WHERE businessentityid = 276)
  = ARRAY['4@2022-05-30-2025-01-31', '6@2025-02-01-open'] AND (SELECT territoryid FROM sales.salesperson WHERE businessentityid = 276) = 6 AS ok;
-- check: orders of 276 since February are booked to Canada while their customers are Southwest customers
SELECT (SELECT count(*) FROM sales.salesorderheader h JOIN sales.customer c USING (customerid)
  WHERE h.salespersonid = 276 AND h.orderdate >= '2025-02-01' AND h.territoryid = 6 AND c.territoryid = 4) > 20 AS ok;
-- unique: no Canada customer is affected; the jump in Canada equals the orders moved
SELECT NOT EXISTS (SELECT 1 FROM sales.salesorderheader h JOIN sales.customer c USING (customerid)
  WHERE h.territoryid IS DISTINCT FROM c.territoryid AND NOT (h.salespersonid = 276 AND h.orderdate >= '2025-02-01')) AS ok;
