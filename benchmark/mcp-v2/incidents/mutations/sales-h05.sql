-- Reseller order 53451 gets a duplicated Touring-2000 Blue, 60 line (2 units at 728.91), entered two weeks
-- after the order. Totals include it; no shipment transaction exists for it. The other line
-- (Touring-3000 promotion, 15% off) is a legitimate discount and acts as a distractor.
INSERT INTO sales.salesorderdetail (salesorderid, salesorderdetailid, carriertrackingnumber, orderqty, productid, specialofferid, unitprice, unitpricediscount, rowguid, modifieddate)
VALUES (53451, 121318, '5401-4E4D-93', 2, 953, 1, 728.9100, 0, '7d1c2a3e-5b4f-4e0a-9c1d-2f3e4a5b6c7d', '2024-08-13');
UPDATE sales.salesorderheader h SET
  taxamt = round(h.taxamt * (h.subtotal + 1457.82) / h.subtotal, 4),
  freight = round(h.freight * (h.subtotal + 1457.82) / h.subtotal, 4),
  subtotal = h.subtotal + 1457.82
WHERE salesorderid = 53451;
UPDATE sales.salesorderheader SET totaldue = subtotal + taxamt + freight WHERE salesorderid = 53451;
