-- anomaly: order 53451 has two identical lines for product 953
SELECT (SELECT count(*) FROM sales.salesorderdetail WHERE salesorderid = 53451 AND productid = 953 AND orderqty = 2 AND unitprice = 728.91) = 2 AS ok;
-- check: only one shipment transaction (2 units) exists for product 953 on order 53451
SELECT (SELECT array_agg(quantity) FROM production.transactionhistory WHERE transactiontype = 'S' AND referenceorderid = 53451 AND productid = 953) = ARRAY[2] AS ok;
-- check: the header subtotal includes both lines
SELECT abs((SELECT subtotal FROM sales.salesorderheader WHERE salesorderid = 53451) - (SELECT sum(unitprice * (1 - unitpricediscount) * orderqty) FROM sales.salesorderdetail WHERE salesorderid = 53451)) < 0.01 AS ok;
-- unique: no other order has two lines for the same product and special offer
SELECT NOT EXISTS (SELECT 1 FROM sales.salesorderdetail WHERE salesorderid <> 53451 GROUP BY salesorderid, productid, specialofferid HAVING count(*) > 1) AS ok;
