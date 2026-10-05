-- anomaly: special offer 10 (50%, started 2024-05-13) is active until 2025-12-31 and was modified 2025-05-31
SELECT (SELECT enddate = '2025-12-31' AND modifieddate = '2025-05-31' AND discountpct = 0.5 FROM sales.specialoffer WHERE specialofferid = 10) AS ok;
-- check: every June 2025 online mountain-tire line uses offer 10 at 50%, and no line used it before June 2025
SELECT (SELECT bool_and(d.specialofferid = 10 AND d.unitpricediscount = 0.5) AND count(*) > 100 FROM sales.salesorderdetail d JOIN sales.salesorderheader h USING (salesorderid)
    WHERE h.onlineorderflag AND h.orderdate >= '2025-06-01' AND d.productid IN (928, 929, 930))
  AND NOT EXISTS (SELECT 1 FROM sales.salesorderdetail d JOIN sales.salesorderheader h USING (salesorderid) WHERE d.specialofferid = 10 AND h.orderdate < '2025-06-01') AS ok;
-- check: tire list prices did not change in 2025
SELECT NOT EXISTS (SELECT 1 FROM production.productlistpricehistory WHERE productid IN (928, 929, 930) AND startdate >= '2025-01-01') AS ok;
-- unique: no other June 2025 online line is discounted
SELECT NOT EXISTS (SELECT 1 FROM sales.salesorderdetail d JOIN sales.salesorderheader h USING (salesorderid)
  WHERE h.onlineorderflag AND h.orderdate >= '2025-06-01' AND d.unitpricediscount > 0 AND d.productid NOT IN (928, 929, 930)) AS ok;
