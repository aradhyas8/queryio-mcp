-- The expired "Mountain Tire Sale" (special offer 10, 50% off, ended 2024-07-28) has its end date pushed
-- to 2025-12-31 on 2025-05-31; June 2025 online mountain-tire lines pick it up at 50% off.
UPDATE sales.specialoffer SET enddate = '2025-12-31', modifieddate = '2025-05-31' WHERE specialofferid = 10;
CREATE TEMP TABLE affected AS
SELECT d.salesorderdetailid, d.salesorderid, d.orderqty * d.unitprice * 0.5 AS cut
FROM sales.salesorderdetail d JOIN sales.salesorderheader h USING (salesorderid)
WHERE h.onlineorderflag AND h.orderdate >= '2025-06-01' AND d.productid IN (928, 929, 930);
UPDATE sales.salesorderdetail d SET specialofferid = 10, unitpricediscount = 0.5 FROM affected a WHERE a.salesorderdetailid = d.salesorderdetailid;
UPDATE sales.salesorderheader h SET
  taxamt = round(h.taxamt * (h.subtotal - c.cut) / h.subtotal, 4),
  freight = round(h.freight * (h.subtotal - c.cut) / h.subtotal, 4),
  subtotal = h.subtotal - c.cut
FROM (SELECT salesorderid, sum(cut) AS cut FROM affected GROUP BY 1) c WHERE c.salesorderid = h.salesorderid;
UPDATE sales.salesorderheader SET totaldue = subtotal + taxamt + freight WHERE salesorderid IN (SELECT salesorderid FROM affected);
DROP TABLE affected;
