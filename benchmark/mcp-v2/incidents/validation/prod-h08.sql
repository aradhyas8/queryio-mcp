-- anomaly: product 707 standard cost is 130.863 from 2025-05-01, ten times its previous cost
SELECT (SELECT array_agg(standardcost::numeric(10,4) || '@' || startdate::date ORDER BY startdate) FROM production.productcosthistory WHERE productid = 707 AND startdate >= '2024-01-01')
  = ARRAY['13.0863@2024-05-29', '130.8630@2025-05-01'] AND (SELECT standardcost FROM production.product WHERE productid = 707) = 130.863 AS ok;
-- check: the cost exceeds the list price, and the sibling helmets keep 13.0863
SELECT (SELECT standardcost > listprice FROM production.product WHERE productid = 707)
  AND (SELECT bool_and(standardcost = 13.0863) FROM production.product WHERE productid IN (708, 711)) AS ok;
-- check: helmet list prices did not change in 2025 and no helmet discount applies in May-June 2025
SELECT NOT EXISTS (SELECT 1 FROM production.productlistpricehistory WHERE productid IN (707, 708, 711) AND startdate >= '2025-01-01')
  AND NOT EXISTS (SELECT 1 FROM sales.salesorderdetail d JOIN sales.salesorderheader h USING (salesorderid)
    WHERE d.productid IN (707, 708, 711) AND h.orderdate >= '2025-05-01' AND d.unitpricediscount > 0) AS ok;
-- unique: no other product has a standard cost above its list price
SELECT NOT EXISTS (SELECT 1 FROM production.product WHERE productid <> 707 AND listprice > 0 AND standardcost > listprice) AS ok;
