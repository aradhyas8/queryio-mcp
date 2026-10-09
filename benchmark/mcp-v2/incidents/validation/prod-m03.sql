-- anomaly: product 877 has two open list price history rows
SELECT (SELECT count(*) FROM production.productlistpricehistory WHERE productid = 877 AND enddate IS NULL) = 2 AS ok;
-- check: the rows are 7.95 from 2024-05-29 and 8.95 from 2025-06-01; product list price is 8.95
SELECT (SELECT array_agg(listprice::numeric(10,2) || '@' || startdate::date ORDER BY startdate) FROM production.productlistpricehistory WHERE productid = 877)
  = ARRAY['7.95@2024-05-29', '8.95@2025-06-01'] AND (SELECT listprice FROM production.product WHERE productid = 877) = 8.95 AS ok;
-- check: June 2025 orders for 877 were charged 7.95
SELECT (SELECT bool_and(d.unitprice = 7.95) AND count(*) > 0 FROM sales.salesorderdetail d JOIN sales.salesorderheader h USING (salesorderid)
  WHERE d.productid = 877 AND h.orderdate >= '2025-06-01') AS ok;
-- unique: no other product has overlapping list price history rows
SELECT NOT EXISTS (SELECT 1 FROM production.productlistpricehistory a JOIN production.productlistpricehistory b
  ON a.productid = b.productid AND a.startdate < b.startdate AND (a.enddate IS NULL OR a.enddate >= b.startdate) WHERE a.productid <> 877) AS ok;
