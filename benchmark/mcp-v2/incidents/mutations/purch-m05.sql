-- PO 3784 (550 Touring Pedals) is assigned to Integrated Sport Products (1636), an apparel vendor,
-- instead of Bicycle Specialists (1628), the product only supplier.
UPDATE purchasing.purchaseorderheader SET vendorid = 1636 WHERE purchaseorderid = 3784;
