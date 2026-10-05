-- anomaly: line 119272 is priced 10x the list price effective on the order date
SELECT EXISTS (SELECT 1 FROM sales.salesorderdetail d JOIN sales.salesorderheader h USING (salesorderid)
  JOIN production.productlistpricehistory lp ON lp.productid = d.productid AND h.orderdate >= lp.startdate AND (lp.enddate IS NULL OR h.orderdate < lp.enddate + interval '1 day')
  WHERE d.salesorderdetailid = 119272 AND d.unitprice = 349.90 AND lp.listprice = 34.99) AS ok;
-- check: the header subtotal and total include the overcharge consistently
SELECT abs((SELECT subtotal FROM sales.salesorderheader WHERE salesorderid = 74219) - (SELECT sum(unitprice * (1 - unitpricediscount) * orderqty) FROM sales.salesorderdetail WHERE salesorderid = 74219)) < 0.01
  AND (SELECT totaldue = subtotal + taxamt + freight FROM sales.salesorderheader WHERE salesorderid = 74219) AS ok;
-- unique: every other online line matches the list price effective on its order date
SELECT NOT EXISTS (SELECT 1 FROM sales.salesorderdetail d JOIN sales.salesorderheader h USING (salesorderid)
  JOIN production.productlistpricehistory lp ON lp.productid = d.productid AND h.orderdate >= lp.startdate AND (lp.enddate IS NULL OR h.orderdate < lp.enddate + interval '1 day')
  WHERE h.onlineorderflag AND d.salesorderdetailid <> 119272 AND d.unitprice <> lp.listprice) AS ok;
