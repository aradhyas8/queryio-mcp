-- anomaly: line 102716 uses volume offer 5 (min 41) for 4 units
SELECT EXISTS (SELECT 1 FROM sales.salesorderdetail d JOIN sales.specialoffer o USING (specialofferid)
  WHERE d.salesorderdetailid = 102716 AND d.orderqty = 4 AND o.specialofferid = 5 AND o.minqty = 41 AND d.unitpricediscount = 0.15) AS ok;
-- check: header subtotal reflects the discounted line
SELECT abs((SELECT subtotal FROM sales.salesorderheader WHERE salesorderid = 69420) - (SELECT sum(unitprice * (1 - unitpricediscount) * orderqty) FROM sales.salesorderdetail WHERE salesorderid = 69420)) < 0.01 AS ok;
-- unique: every other discounted volume-offer line is within the offer quantity range
SELECT NOT EXISTS (SELECT 1 FROM sales.salesorderdetail d JOIN sales.specialoffer o USING (specialofferid)
  WHERE d.salesorderdetailid <> 102716 AND o.type = 'Volume Discount' AND d.unitpricediscount > 0 AND (d.orderqty < o.minqty OR d.orderqty > coalesce(o.maxqty, 32767))) AS ok;
